import type { ClinicMemoryPersistenceDecision, ShortTermState, TurnMemoryInput } from "../../domain/contracts";

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isDiscardableUserTurn(text: string): boolean {
  if (!text) {
    return true;
  }

  if (text.length <= 3 && !/\d/.test(text)) {
    return true;
  }

  return hasAny(text, [
    /^(gracias|muchas gracias|mil gracias)$/,
    /^(ok|okay|vale|va|sale|perfecto|claro|entendido)$/,
    /^(si|sí|no)$/,
    /^(listo|hecho|excelente)$/
  ]);
}

function hasIdentitySignal(text: string): boolean {
  return hasAny(text, [
    /\b(mi nombre es|me llamo|llamame|soy)\b/,
    /\bmi whatsapp\b/,
    /\bmi correo\b/,
    /\bmi email\b/,
    /\bmi telefono\b/
  ]);
}

function hasPreferenceSignal(text: string): boolean {
  return hasAny(text, [
    /\b(prefiero|preferiria|mejor)\b/,
    /\bsolo puedo\b/,
    /\bno puedo\b/,
    /\bme acomoda\b/,
    /\bme viene bien\b/,
    /\bwhatsapp\b/,
    /\bcorreo\b/,
    /\bemail\b/,
    /\btelefono\b/,
    /\btarjeta\b/,
    /\btransferencia\b/,
    /\befectivo\b/,
    /\bpresencial\b/,
    /\ben linea\b/,
    /\bonline\b/
  ]);
}

function hasClinicalContextSignal(text: string): boolean {
  const firstPerson = hasAny(text, [
    /\bme siento\b/,
    /\btengo\b/,
    /\bhe estado\b/,
    /\bllevo\b/,
    /\bsufro\b/,
    /\bme diagnosticaron\b/,
    /\bando con\b/
  ]);
  const concerns = hasAny(text, [
    /\bansiedad\b/,
    /\bdepresion\b/,
    /\binsomnio\b/,
    /\bestres\b/,
    /\bcrisis\b/,
    /\bcansancio\b/,
    /\bmotivacion\b/,
    /\bpanico\b/,
    /\btriste\b/,
    /\bseguimiento\b/,
    /\bpsiquiatr/i,
    /\bpsicoterapia\b/,
    /\bterapia\b/
  ]);

  return firstPerson && concerns;
}

function looksLikeAvailabilitySignal(text: string): boolean {
  return hasAny(text, [
    /\b(hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/,
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
    /\b\d{1,2}:\d{2}\s?(?:am|pm)?\b/,
    /\b\d{1,2}\s?(?:am|pm)\b/,
    /\bpor la manana\b/,
    /\bpor la tarde\b/,
    /\bpor la noche\b/
  ]);
}

function hasAppointmentIntentSignal(text: string): boolean {
  return hasAny(text, [
    /\b(cita|agendar|agenda|reagendar|reservar|turno)\b/,
    /\b(valoracion|evaluacion|psiquiatria|psicoterapia|seguimiento)\b/
  ]);
}

function hasAppointmentDataSignal(turn: TurnMemoryInput, text: string, shortTerm: ShortTermState): boolean {
  if (turn.route !== "appointment" && shortTerm.activeGoal !== "appointment") {
    return false;
  }

  return looksLikeAvailabilitySignal(text) || hasIdentitySignal(text) || hasAppointmentIntentSignal(text);
}

export function shouldEvaluateClinicMemoryWithLlm(
  turn: TurnMemoryInput,
  _shortTerm: ShortTermState,
  domainState: Record<string, unknown>
): boolean {
  const userText = normalizeText(turn.user_message);
  if (domainState.handoff_required === true) {
    return true;
  }

  return !isDiscardableUserTurn(userText);
}

export function decideClinicMemoryPersistenceHeuristic(
  turn: TurnMemoryInput,
  shortTerm: ShortTermState,
  domainState: Record<string, unknown>
): ClinicMemoryPersistenceDecision {
  const userText = normalizeText(turn.user_message);
  const assistantText = normalizeText(turn.assistant_message);
  const reasons: string[] = [];
  const handoffRequired = domainState.handoff_required === true;

  let shouldStoreProfile = false;
  if (!isDiscardableUserTurn(userText)) {
    if (hasIdentitySignal(userText)) {
      shouldStoreProfile = true;
      reasons.push("identity");
    }
    if (hasPreferenceSignal(userText)) {
      shouldStoreProfile = true;
      reasons.push("preference");
    }
    if (hasClinicalContextSignal(userText)) {
      shouldStoreProfile = true;
      reasons.push("clinical_context");
    }
    if (hasAppointmentDataSignal(turn, userText, shortTerm)) {
      shouldStoreProfile = true;
      reasons.push("appointment_context");
    }
  }

  const shouldStoreEpisode = handoffRequired && assistantText.length >= 18;
  if (shouldStoreEpisode) {
    reasons.push("handoff");
  }

  return {
    shouldStore: shouldStoreProfile || shouldStoreEpisode,
    shouldStoreProfile,
    shouldStoreEpisode,
    reasons: Array.from(new Set(reasons)),
    source: "heuristic"
  };
}
