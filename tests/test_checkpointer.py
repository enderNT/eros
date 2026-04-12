import asyncio
from contextlib import asynccontextmanager

from app.services.checkpointer import ResilientAsyncPostgresCheckpointer


class FakeOperationalError(Exception):
    pass


def test_resilient_checkpointer_reconnects_after_connection_error():
    events = []

    class FakeSaver:
        def __init__(self, name, *, should_fail):
            self.name = name
            self.should_fail = should_fail

        async def setup(self):
            events.append(f"setup:{self.name}")

        async def aget_tuple(self, config):
            del config
            events.append(f"aget_tuple:{self.name}")
            if self.should_fail:
                raise FakeOperationalError("the connection is closed")
            return {"ok": True, "name": self.name}

    savers = [FakeSaver("first", should_fail=True), FakeSaver("second", should_fail=False)]

    @asynccontextmanager
    async def fake_factory(dsn):
        del dsn
        saver = savers.pop(0)
        events.append(f"enter:{saver.name}")
        try:
            yield saver
        finally:
            events.append(f"exit:{saver.name}")

    async def run_test():
        checkpointer = ResilientAsyncPostgresCheckpointer("postgresql://unused", saver_factory=fake_factory)
        await checkpointer.setup()
        result = await checkpointer.aget_tuple({"configurable": {"thread_id": "1"}})
        await checkpointer.close()
        return result

    result = asyncio.run(run_test())

    assert result == {"ok": True, "name": "second"}
    assert events == [
        "enter:first",
        "setup:first",
        "aget_tuple:first",
        "exit:first",
        "enter:second",
        "aget_tuple:second",
        "exit:second",
    ]
