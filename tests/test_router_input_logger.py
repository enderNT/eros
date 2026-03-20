from app.observability.router_input_logger import configure_router_input_logger, log_router_input


def test_router_input_logger_is_silent_when_disabled(capsys):
    configure_router_input_logger(False)

    log_router_input("Mensaje de prueba")

    captured = capsys.readouterr()
    assert captured.err == ""
    assert captured.out == ""


def test_router_input_logger_emits_context_when_enabled(capsys):
    configure_router_input_logger(True)

    log_router_input("Mensaje de prueba")

    captured = capsys.readouterr()
    assert "ESTO ES EL CONTEXTO WE:" in captured.err
    assert "Mensaje de prueba" in captured.err

    configure_router_input_logger(False)
