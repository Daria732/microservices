'use strict';
/**
 * Единая модель ошибок для всех сервисов: RFC 7807 (Problem Details)
 * + поля code / message / details из OpenAPI-контрактов лабораторной №3,
 * чтобы ответ одновременно соответствовал и RFC 7807, и контракту.
 */
const TITLES = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function toProblem(err, instance) {
  const body = {
    type: `https://foodfit.example/problems/${String(err.code).toLowerCase().replace(/_/g, '-')}`,
    title: TITLES[err.status] || 'Error',
    status: err.status,
    detail: err.message,
    instance,
    code: err.code,
    message: err.message,
  };
  if (err.details) body.details = err.details;
  return body;
}

module.exports = { ApiError, toProblem };
