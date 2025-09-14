const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { onlyAdmin } = require("../middleware/roles");
const { list, create, remove, bulkCreate } = require("../controllers/questionsController");

// Listar preguntas
router.get("/", requireAuth, onlyAdmin, list);

// Crear una pregunta
router.post("/", requireAuth, onlyAdmin, create);

// Eliminar una pregunta
router.delete("/:id", requireAuth, onlyAdmin, remove);

// Subida masiva
router.post("/bulk", requireAuth, onlyAdmin, bulkCreate);

module.exports = router;