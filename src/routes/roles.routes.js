const express = require('express');
const { body, param, validationResult } = require('express-validator');
const router  = express.Router();

const {
  getAllRoles, getRoleById, createRole, updateRole, deleteRole, getAllPermissions,
} = require('../controllers/roles.controller');
const { authenticate, authorizeRoles, auditLog } = require('../middleware/auth.middleware');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

const roleValidation = [
  body('name').trim().notEmpty().withMessage('Role name is required')
    .isLength({ max: 50 }).withMessage('Name max 50 chars'),
  body('description').optional().isLength({ max: 255 }),
  body('permissionIds').optional().isArray(),
];

// All routes require Admin
router.use(authenticate, authorizeRoles('Admin'));

router.get('/',       getAllRoles);
router.get('/permissions', getAllPermissions);
router.get('/:id',    param('id').isInt(), validate, getRoleById);

router.post('/',
  roleValidation, validate,
  auditLog('ROLE_CREATED', 'roles'),
  createRole
);

router.put('/:id',
  [param('id').isInt(), ...roleValidation], validate,
  auditLog('ROLE_UPDATED', 'roles'),
  updateRole
);

router.delete('/:id',
  param('id').isInt(), validate,
  auditLog('ROLE_DELETED', 'roles'),
  deleteRole
);

module.exports = router;