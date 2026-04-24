const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/holiday.controller');

const auth    = [authenticate];
const adminHR = [authenticate, authorizeRoles('Admin', 'HR')];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Public reads (all authenticated users)
router.get('/',             auth,    ctrl.getAll);
router.get('/stats',        auth,    ctrl.getStats);
router.get('/working-days', auth,    ctrl.getWorkingDays);

// HR writes
router.post('/',
  adminHR,
  [body('name').notEmpty().withMessage('Name required'), body('date').isDate().withMessage('Valid date required')],
  validate, ctrl.create
);
router.put('/:id',
  adminHR,
  [body('name').notEmpty(), body('date').isDate()],
  validate, ctrl.update
);
router.delete('/:id', adminHR, ctrl.remove);

// Bulk import
router.post('/bulk', adminHR, ctrl.bulkImport);

// Employee opt-in / opt-out for optional holidays
router.post('/:id/opt',   auth, ctrl.optIn);
router.delete('/:id/opt', auth, ctrl.optOut);

module.exports = router;