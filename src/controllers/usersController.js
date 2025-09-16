const bcrypt = require("bcryptjs");
const User = require("../models/User");

async function listUsers(_, res) {
    const users = await User.find().select("-password");
    res.json(users);
}

async function createUser(req, res) {
    const { name, username, email, password, role = "player" } = req.body;
    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists) return res.status(409).json({ message: "Usuario o email ya existente" });
    const hash = await bcrypt.hash(password, 10);
    const u = await User.create({ name, username, email, password: hash, role });
    res.status(201).json({ id: u._id });
}

module.exports = { listUsers, createUser };