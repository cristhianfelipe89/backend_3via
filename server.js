const express = require("express");
const http = require("http");
const cors = require("cors");
const morgan = require("morgan");
const dotenv = require("dotenv");
const { Server } = require("socket.io");


dotenv.config();

const connectDB = require("./src/config/db");
const { socketAuthMiddleware, gameSocket } = require("./src/sockets/gameSocket");

connectDB();

const app = express();
app.use(cors({ origin: (process.env.CORS_ORIGIN || "*").split(",") }));
app.use(express.json());
app.use(morgan("dev"));

// REST routes
app.get("/api/health", (_, res) => res.json({ ok: true }));
app.use("/api/auth", require("./src/routes/authRoutes"));
app.use("/api/users", require("./src/routes/usersRoutes"));
app.use("/api/questions", require("./src/routes/questionsRoutes"));
app.use("/api/stats", require("./src/routes/statsRoutes"));



const server = http.createServer(app);

// Socket.IO con auth por JWT
const io = new Server(server, {
    cors: {
        origin: (process.env.CORS_ORIGIN || "*").split(","),
        methods: ["GET", "POST"]
    }
});
io.use(socketAuthMiddleware);    // verifica token y adjunta user en socket
io.on("connection", (socket) => gameSocket(io, socket));



const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`API+WS running on :${PORT}`));