import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClinicConfigLoader } from "../src/core/services/clinic-config-loader";

describe("ClinicConfigLoader", () => {
  test("returns empty context when clinic config file is missing", async () => {
    const missingPath = join(tmpdir(), `clinic-missing-${Date.now()}.json`);
    const loader = new ClinicConfigLoader(missingPath);

    await expect(loader.load()).resolves.toEqual({
      clinic_name: "Clinica no configurada",
      timezone: "America/Mexico_City",
      services: [],
      doctors: [],
      hours: {},
      policies: {}
    });
    await expect(loader.toContextText()).resolves.toBe("");
  });

  test("renders context text when clinic config file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clinic-config-"));
    const filePath = join(dir, "clinic.json");
    const loader = new ClinicConfigLoader(filePath);

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          clinic_name: "Eros",
          timezone: "America/Mexico_City",
          services: [{ name: "Consulta", duration_minutes: 60, price: "$800" }],
          doctors: [{ name: "Dra. Ana", specialty: "Psiquiatria", availability_notes: "Lunes a viernes" }],
          hours: { lunes: "09:00-18:00" },
          policies: { cancelacion: "24 horas" }
        }),
        "utf8"
      );

      const context = await loader.toContextText();
      expect(context).toContain("Clinica: Eros");
      expect(context).toContain("Servicios:");
      expect(context).toContain("Doctores:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
