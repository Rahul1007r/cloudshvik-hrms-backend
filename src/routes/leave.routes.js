const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/leave.controller');

const auth     = [authenticate];
const adminHR  = [authenticate, authorizeRoles('Admin', 'HR', 'Manager')];
const adminOnly= [authenticate, authorizeRoles('Admin', 'HR')];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Leave types
router.get('/types',            auth,      ctrl.getLeaveTypes);
router.post('/types',           adminOnly,
  [body('name').notEmpty(), body('code').notEmpty()], validate, ctrl.createLeaveType
);
router.put('/types/:id',        adminOnly, ctrl.updateLeaveType);

// Stats & calendar
router.get('/stats',            adminHR,   ctrl.getStats);
router.get('/calendar',         auth,      ctrl.getCalendar);

// Balance
router.get('/balance',          auth,      ctrl.getBalance);

// Requests
router.get('/requests',         auth,      ctrl.getRequests);
router.post('/apply',           auth,
  [
    body('leave_type_id').notEmpty().withMessage('Leave type required'),
    body('start_date').isDate().withMessage('Valid start date required'),
    body('end_date').isDate().withMessage('Valid end date required'),
  ],
  validate, ctrl.apply
);

// Approval workflow
router.post('/:id/approve',     adminHR,   ctrl.approve);
router.post('/:id/reject',      adminHR,   ctrl.reject);
router.patch('/:id/cancel',     auth,      ctrl.cancel);

module.exports = router;