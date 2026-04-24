const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/salaryRevision.controller');

const hr  = [authenticate, authorizeRoles('Admin', 'HR')];
const mgr = [authenticate, authorizeRoles('Admin', 'HR', 'Manager')];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Stats & lists
router.get('/stats',                         hr,  ctrl.getStats);
router.get('/',                              hr,  ctrl.getAll);
router.get('/employee/:empId',               hr,  ctrl.getByEmployee);
router.get('/employee-structure/:empId',     hr,  ctrl.getEmployeeStructure);
router.get('/:id',                           hr,  ctrl.getOne);

// Create single revision
router.post('/',
  hr,
  [
    body('employee_id').notEmpty().withMessage('Employee required'),
    body('revision_type').notEmpty().withMessage('Revision type required'),
    body('effective_date').isDate().withMessage('Valid effective date required'),
    body('new_basic').isNumeric().withMessage('New basic salary required'),
  ],
  validate, ctrl.create
);

// Bulk revision (runs before /:id routes)
router.post('/bulk',
  hr,
  [
    body('batch_name').notEmpty().trim().withMessage('Batch name required'),
    body('effective_date').isDate().withMessage('Effective date required'),
    body('increment_type').isIn(['Percentage', 'Fixed Amount', 'New CTC']),
    body('increment_value').isNumeric().withMessage('Increment value required'),
  ],
  validate, ctrl.createBulk
);

// Workflow actions
router.post('/:id/submit',    hr,  ctrl.submit);
router.post('/:id/approve',   mgr, ctrl.approve);
router.post('/:id/reject',    mgr,
  [body('rejection_reason').notEmpty().withMessage('Rejection reason required')],
  validate, ctrl.reject
);
router.post('/:id/implement', hr,  ctrl.implement);

module.exports = router;