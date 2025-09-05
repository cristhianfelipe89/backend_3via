const Question = require("../models/Question");

async function list(req, res) {
    const q = await Question.find();
    res.json(q);
}
async function create(req, res) {
    const saved = await Question.create(req.body);
    res.status(201).json(saved);
}
async function remove(req, res) {
    await Question.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
}
module.exports = { list, create, remove };