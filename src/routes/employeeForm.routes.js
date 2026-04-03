const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizePermission } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/employeeForm.controller');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

const canView   = [authenticate, authorizePermission('employees', 'view')];
const canCreate = [authenticate, authorizePermission('employees', 'create')];
const canEdit   = [authenticate, authorizePermission('employees', 'edit')];

// Form meta (dropdowns + next ID)
router.get('/form-meta',    canView, ctrl.getFormMeta);

// Full employee for edit
router.get('/:id/full',     canView, ctrl.getEmployeeForEdit);

// Email availability check
router.post('/check-email', canView, ctrl.checkEmail);

// Create
router.post('/',
  canCreate,
  [
    body('full_name').notEmpty().trim().withMessage('Full name required'),
    body('email').isEmail().withMessage('Valid email required'),
    body('employment_type').optional().isIn(['Full-Time','Part-Time','Contract','Intern']),
    body('work_location').optional().isIn(['Office','Remote','Hybrid']),
  ],
  validate,
  ctrl.createEmployee
);

// Update
router.put('/:id',
  canEdit,
  [body('full_name').notEmpty().trim().withMessage('Full name required')],
  validate,
  ctrl.updateEmployee
);

module.exports = router;