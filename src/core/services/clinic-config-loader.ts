import { readFile } from "node:fs/promises";
import type { ClinicConfig } from "../../domain/contracts";

export class ClinicConfigLoader {
  private cached: ClinicConfig | null = null;

  constructor(private readonly configPath: string) {}

  async load(): Promise<ClinicConfig> {
    if (this.cached) {
      return this.cached;
    }

    const raw = await readFile(this.configPath, "utf8");
    this.cached = JSON.parse(raw) as ClinicConfig;
    return this.cached;
  }

  async toContextText(): Promise<string> {
    const config = await this.load();
    const services = config.services
      .map((service) => `- ${String(service.name ?? "Servicio")}: ${String(service.duration_minutes ?? "N/D")} min, ${String(service.price ?? "N/D")}`)
      .join("\n");
    const doctors = config.doctors
      .map((doctor) => `- ${String(doctor.name ?? "Profesional")} (${String(doctor.specialty ?? "Sin especialidad")}): ${String(doctor.availability_notes ?? doctor.notes ?? "Sin nota")}`)
      .join("\n");
    const hours = Object.entries(config.hours ?? {})
      .map(([day, schedule]) => `- ${day}: ${schedule}`)
      .join("\n");
    const policies = Object.entries(config.policies ?? {})
      .map(([name, value]) => `- ${name}: ${value}`)
      .join("\n");

    return [
      `Clinica: ${config.clinic_name}`,
      `Zona horaria: ${config.timezone}`,
      "Servicios:",
      services || "- Sin servicios",
      "Doctores:",
      doctors || "- Sin doctores",
      "Horarios:",
      hours || "- Sin horarios",
      "Politicas:",
      policies || "- Sin politicas"
    ].join("\n");
  }
}
