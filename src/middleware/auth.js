const { verify } = require("../utils/token");

function requireAuth(req, res, next) {
    const raw = req.headers.authorization || "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;

    if (!token) {
        console.log("[Auth] No token en headers");
        return res.status(401).json({ message: "No token" });
    }

    try {
        req.user = verify(token); // { id, role, name }
        next();
    } catch (err) {
        console.log("[Auth] Token inválido:", err.message);
        return res.status(401).json({ message: "Invalid token" });
    }
}

module.exports = { requireAuth };
