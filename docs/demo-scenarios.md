# Сценарии демонстрации (лабораторная работа №4)

Демонстрация выполняется в Postman: коллекция `postman/FoodFit-lab4.postman_collection.json`. Все запросы (включая административные) направляются только на `http://localhost:8080` — API Gateway.
Параллельно открыт терминал с логами сервисов (`npm start`) — по ним видно, что каждый сервис **реально получил запрос или событие**.
Каждая строка лога содержит `[req=xxxxxxxx]` — сквозной идентификатор запроса: один и тот же `req` виден в gateway, сервисах и брокере.

## Что реальное, что мок

| Элемент | Статус | Пояснение |
|---|---|---|
| profile, food, diary, nutrition, recommendation | **реальные сервисы** | отдельные процессы, свои хранилища (in-memory) |
| Вызовы diary→food, nutrition→profile, recommendation→nutrition/profile | **реальные HTTP-вызовы** между сервисами | по `/internal/v1/...` из контрактов |
| События MealEntryCreated/Updated/Deleted, DailyNutritionSummaryUpdated, UserProfileUpdated, RecommendationGenerated | **реальная публикация и обработка** | транспорт — мок брокера |
| RabbitMQ | **МОК** (`mocks/message-broker`) | in-memory брокер: очереди, ack, Retry Queue, DLQ |
| API Gateway (Kong) | **упрощён** | свой минимальный gateway: маршрутизация, проверка токена, `X-User-Id`, `X-Request-Id` |
| Keycloak (JWT) | **МОК** | токен вида `mock-jwt-<userId>` проверяется в gateway |
| Open Food Facts | **МОК** | каталог из 10 продуктов в food-service |
| Redis | не используется | |
| activity-service, recipe-service | не реализованы | gateway отвечает `501` |

## Сценарий 1. Успешный сквозной сценарий (папка A)

Цепочка: **Клиент → Gateway → diary → (sync) food → БД diary + outbox → брокер → nutrition → (sync) profile → БД nutrition → брокер → recommendation.**

| Шаг | Запрос Postman | Ожидаемый результат | Что видно в логах |
|---|---|---|---|
| 1 | A1 создать профиль | 201 | gateway: токен проверен → profile-service; profile-service: запрос получен |
| 2 | A2 нормы питания | 200, `dailyCalories` | nutrition: `SYNC → profile-service`; profile: запрос `/internal/v1/profiles/...` |
| 3 | A3 поиск продуктов | 200, продукт найден | food-service: поиск |
| 4 | A4 запись в дневник | 201, `calories: 370` | diary: `SYNC → food-service`, `OUTBOX: MealEntryCreated`; брокер: `DELIVER → nutrition-service`; nutrition: `EVENT ← MealEntryCreated`, `SYNC → profile-service`; recommendation: `EVENT ← DailyNutritionSummaryUpdated` |
| 5 | A5 дневная сводка | `consumedCalories ≥ 370`, остаток от нормы | — |
| 6 | A6 рекомендации | «Увеличьте потребление белка» | recommendation: `рекомендация сформирована` |

## Сценарий 2. Идемпотентность и единая модель ошибок (папки B, C)

* B2: повтор с тем же `Idempotency-Key` → тот же `entryId`, заголовок `Idempotent-Replayed: true`, в логе diary — `IDEMPOTENCY: ... операция не выполняется`.
* B3: тот же ключ с другим телом → `422 IDEMPOTENCY_KEY_REUSED`; B4: без ключа → `400`.
* C1–C6: все ошибки в формате `application/problem+json` (RFC 7807 + `code`/`message` из контрактов); `401` без токена, `/internal/*` через gateway → `404`.

## Сценарий 3. Сбой синхронного вызова (папка D)

food-service «выключается» (`POST /admin/services/food/chaos` через Gateway) → создание записи возвращает `503 SERVICE_UNAVAILABLE`. В логах diary: `SYNC ✗ ...`. Запись и событие **не создаются**, компенсировать нечего.

## Сценарий 4. Сбой асинхронной обработки и повторная доставка (папка E, диаграмма `sequence-failure.md`)

1. nutrition-service выключен через `POST /admin/services/nutrition/chaos` Gateway, создаётся запись → пользователь всё равно получает `201`.
2. Брокер: `NACK ✗ ... перемещаю в Retry Queue, повтор через 3000 мс`, `GET /admin/broker/queues` Gateway показывает `retried ≥ 1`.
3. nutrition включён → очередная попытка проходит: `ACK ✓`, сводка обновлена, рекомендации пересчитаны (итоговая согласованность).

## Сценарий 5. Сага с компенсацией (папка F)

Хореографическая сага из трёх участников: **diary → nutrition → diary (компенсация)**, транспорт — брокер.

1. nutrition выключен, создаётся запись (`201`) — шаг 1 саги (локальная транзакция diary).
2. Брокер делает 5 попыток с интервалом 3 с (~12 с), затем `DEAD-LETTER ✗` и публикует `MealEntryCreated.DeadLettered`.
3. diary-service получает это событие и выполняет **компенсирующее действие**: `COMPENSATION: ... запись откатана`.
4. F4: запись → `404`; F5: `GET /admin/diary/compensations` Gateway содержит запись; F6: сообщение лежит в DLQ.

> Для F4 и E5 в коллекции встроены паузы (15 и 5 с) — Postman на это время «замирает», это нормально.


## Административные запросы через Gateway

Для управления имитацией сбоев и просмотра служебной информации используется отдельный административный токен `Authorization: Bearer mock-jwt-admin`. Поддерживаемые маршруты:

- `GET/POST /admin/services/{profile|food|diary|nutrition|recommendation}/chaos` — просмотр/переключение режима имитации сбоя конкретного сервиса;
- `GET /admin/broker/queues` — состояние очередей и счётчики повторов;
- `GET /admin/broker/dlq` — Dead Letter Queue;
- `GET /admin/diary/compensations` — журнал компенсирующих действий.

API Gateway проверяет административный токен и проксирует запрос к нужному сервису/брокеру. Пользовательский токен не даёт доступа к `/admin/*` (403), а `/internal/*` остаётся закрытым (404). В Docker Compose опубликован только порт 8080 Gateway; порты сервисов и брокера не опубликованы на хост.
