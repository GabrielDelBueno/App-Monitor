import { createApp } from "../../backend/src/server.js";
import { createUser } from "../../backend/src/database.js";
const { app, db } = createApp({ databasePath: ":memory:" });
createUser(db, {
  name: "Administrador Teste",
  email: "admin@browser.local",
  password: "Browser-test-123!",
  role: "ADMINISTRADOR",
});
db.prepare("UPDATE users SET is_manager=1 WHERE email=?").run(
  "admin@browser.local",
);
app.listen(3344, "127.0.0.1");
