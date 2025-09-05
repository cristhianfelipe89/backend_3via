const { verify } = require("../utils/token");

function requireAuth(req, res, next) {
    const raw = req.headers.authorization || "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
    if (!token) return res.status(401).json({ message: "No token" });
    try {
        req.user = verify(token); // { id, role, name }
        next();
    } catch {
        return res.status(401).json({ message: "Invalid token" });
    }
}

module.exports = { requireAuth };