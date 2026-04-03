const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/attendanceApproval.controller');

const auth    = [authenticate];
const mgr     = [authenticate, authorizeRoles('Admin', 'HR', 'Manager')];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Stats
router.get('/stats',  mgr, ctrl.getApprovalStats);

// Team attendance view + approval
router.get('/team',   mgr, ctrl.getTeamAttendance);
router.post('/approve/:attendanceId',  mgr, ctrl.approveAttendance);
router.post('/bulk-approve',           mgr,
  [body('attendance_ids').isArray({ min:1 }).withMessage('Provide at least one ID')],
  validate, ctrl.bulkApprove
);

// Regularization requests
router.get('/regularizations',  auth, ctrl.getRegularizations);
router.post('/regularizations', auth,
  [
    body('request_date').isDate().withMessage('Valid date required'),
    body('reason').notEmpty().withMessage('Reason is required'),
  ],
  validate, ctrl.createRegularization
);
router.post('/regularizations/:id/approve', mgr, ctrl.approveRegularization);
router.post('/regularizations/:id/reject',  mgr,
  [body('rejection_reason').notEmpty().withMessage('Rejection reason required')],
  validate, ctrl.rejectRegularization
);

module.exports = router;