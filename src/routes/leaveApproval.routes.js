const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/leaveApproval.controller');

const mgr = [authenticate, authorizeRoles('Admin', 'HR', 'Manager')];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

router.get('/stats',          mgr, ctrl.getStats);
router.get('/pending',        mgr, ctrl.getPending);
router.get('/history',        mgr, ctrl.getHistory);
router.get('/team-balance',   mgr, ctrl.getTeamBalance);
router.get('/calendar',       mgr, ctrl.getTeamCalendar);

router.post('/:id/approve',   mgr, ctrl.approve);
router.post('/:id/reject',    mgr,
  [body('rejection_reason').notEmpty().withMessage('Rejection reason required')],
  validate, ctrl.reject
);
router.post('/bulk-approve',  mgr,
  [body('ids').isArray({ min: 1 }).withMessage('Provide at least one ID')],
  validate, ctrl.bulkApprove
);

module.exports = router;