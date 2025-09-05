const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { onlyAdmin } = require("../middleware/roles");
const { list, create, remove } = require("../controllers/questionsController");

router.get("/", requireAuth, onlyAdmin, list);
router.post("/", requireAuth, onlyAdmin, create);
router.delete("/:id", requireAuth, onlyAdmin, remove);

module.exports = router;