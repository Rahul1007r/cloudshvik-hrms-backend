const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles, authorizePermission } = require('../middleware/auth.middleware');
const {
  getAll, getById, create, update, toggleStatus, remove,
  getFormOptions, getStats,
} = require('../controllers/employees.controller');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

const canView   = [authenticate, authorizePermission('employees', 'view')];
const canCreate = [authenticate, authorizePermission('employees', 'create')];
const canEdit   = [authenticate, authorizePermission('employees', 'edit')];
const canDelete = [authenticate, authorizePermission('employees', 'delete')];

// ── Meta (dropdowns, stats) ───────────────────────────────
router.get('/meta/options', canView, getFormOptions);
router.get('/meta/stats',   canView, getStats);

// ── CRUD ──────────────────────────────────────────────────
router.get('/',    canView, getAll);
router.get('/:id', canView, getById);

router.post('/',
  canCreate,
  [
    body('full_name').notEmpty().trim().withMessage('Full name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('employment_type').optional().isIn(['Full-Time','Part-Time','Contract','Intern']),
    body('work_location').optional().isIn(['Office','Remote','Hybrid']),
  ],
  validate,
  create
);

router.put('/:id',
  canEdit,
  [
    body('full_name').notEmpty().trim().withMessage('Full name is required'),
    body('employment_type').optional().isIn(['Full-Time','Part-Time','Contract','Intern']),
  ],
  validate,
  update
);

router.patch('/:id/toggle-status', canEdit,   toggleStatus);
router.delete('/:id',              canDelete, remove);

module.exports = router;