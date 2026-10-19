// Единый тип ошибки для всех методов api (оба бэкенда бросают только его).

export const ERROR_MESSAGES = {
  auth_required: "Нужно войти в аккаунт",
  forbidden: "Недостаточно прав",
  not_found: "Не найдено",
  validation: "Проверь заполнение полей",
  invalid_credentials: "Неверный email или пароль",
  email_taken: "Этот email уже зарегистрирован",
  nick_taken: "Этот ник уже занят",
  network: "Нет связи с сервером, попробуй ещё раз",
  rate_limited: "Слишком много запросов, подожди немного",
  unknown: "Что-то пошло не так",
};

export class ApiError extends Error {
  /**
   * @param {keyof ERROR_MESSAGES} code
   * @param {string} [message] — человекочитаемый текст (по умолчанию из ERROR_MESSAGES)
   * @param {Record<string,string>} [fields] — ошибки по полям формы: { title: "Слишком коротко" }
   */
  constructor(code, message, fields) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown);
    this.name = "ApiError";
    this.code = code;
    this.fields = fields || null;
  }
}

/** Приводит любую ошибку к ApiError (для catch в UI). */
export const toApiError = (e) =>
  e instanceof ApiError ? e : new ApiError(e?.name === "TypeError" ? "network" : "unknown", e?.message);
