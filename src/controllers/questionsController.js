const Question = require("../models/Question");

/** Listar todas las preguntas */
async function list(req, res) {
    const q = await Question.find();
    res.json(q);
}

/** Crear una pregunta individual */
async function create(req, res) {
    try {
        const saved = await Question.create(req.body);
        res.status(201).json(saved);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
}

/** Eliminar una pregunta */
async function remove(req, res) {
    await Question.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
}

/** Subida masiva de preguntas desde JSON */
async function bulkCreate(req, res) {
    try {
        if (!Array.isArray(req.body)) {
            return res.status(400).json({ error: "Se espera un array de preguntas" });
        }

        // Validar estructura mínima
        const invalids = req.body.filter(
            q => !q.statement || !Array.isArray(q.options) || q.correctIndex === undefined || !q.category
        );

        if (invalids.length > 0) {
            return res.status(400).json({ error: "Algunas preguntas no cumplen con la estructura" });
        }

        const saved = await Question.insertMany(req.body);
        res.status(201).json({ inserted: saved.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = { list, create, remove, bulkCreate };