import { startCollectorServer } from "./server/collector.server.js";

// Chạy trong container: mọi cấu hình đọc từ biến môi trường (xem README).
// exitOnSignal: SIGTERM của ECS/Docker → đóng server, ghi + upload hết rồi thoát.
startCollectorServer({ exitOnSignal: true });
