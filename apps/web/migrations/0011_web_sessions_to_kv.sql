-- Web sessions moved to KV (AUTH_KV, bound to apps/web only; src/server/session-store.ts), since
-- this database is also bound to apps/arena. Dropping the table removes every plaintext session
-- token it held (and its index). Everyone signed in is signed out once.
DROP TABLE `sessions`;
