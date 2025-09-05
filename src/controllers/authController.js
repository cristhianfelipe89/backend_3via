const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { sign } = require("../utils/token");

async function register(req, res) {
    try {
        const { name, username, email, password } = req.body;
        if (!name || !username || !email || !password)
            return res.status(400).json({ message: "Datos incompletos" });

        const exists = await User.findOne({ $or: [{ email }, { username }] });
        if (exists) return res.status(409).json({ message: "Usuario o email ya existente" });

        const hash = await bcrypt.hash(password, 10);
        const user = await User.create({ name, username, email, password: hash, role: "player" });
        const token = sign({ id: user._id, role: user.role, name: user.name });

        res.json({ token, user: { id: user._id, name: user.name, role: user.role } });
    } catch (e) { res.status(500).json({ message: e.message }); }
}

async function login(req, res) {
    try {
        const { emailOrUsername, password } = req.body;
        const user = await User.findOne({
            $or: [{ email: emailOrUsername }, { username: emailOrUsername }]
        });
        if (!user) return res.status(401).json({ message: "Credenciales inválidas" });
        const ok = await bcrypt.compare(password, user.password);
        if (!ok) return res.status(401).json({ message: "Credenciales inválidas" });

        const token = sign({ id: user._id, role: user.role, name: user.name });
        res.json({ token, user: { id: user._id, name: user.name, role: user.role } });
    } catch (e) { res.status(500).json({ message: e.message }); }
}

module.exports = { register, login };