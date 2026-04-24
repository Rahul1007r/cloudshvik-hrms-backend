const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/performance.controller');

const hr   = [authenticate, authorizeRoles('Admin','HR')];
const mgr  = [authenticate, authorizeRoles('Admin','HR','Manager')];
const auth = [authenticate];

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success:false, errors:errs.array() });
  next();
};

// Dashboard & self-view
router.get('/stats',                           mgr,  ctrl.getStats);
router.get('/my-review',                       auth, ctrl.getMyReview);

// Review Cycles
router.get('/cycles',                          mgr,  ctrl.getCycles);
router.post('/cycles',                         hr,
  [body('name').notEmpty(), body('start_date').isDate(), body('end_date').isDate(),
   body('review_from').isDate(), body('review_to').isDate()],
  validate, ctrl.createCycle
);
router.patch('/cycles/:id/status',             hr,   ctrl.updateCycleStatus);
router.post('/cycles/:id/launch',              hr,   ctrl.launchCycle);

// Goals
router.get('/goals',                           auth, ctrl.getGoals);
router.post('/goals',                          auth,
  [body('title').notEmpty().trim()],
  validate, ctrl.createGoal
);
router.patch('/goals/:id',                     auth, ctrl.updateGoal);
router.delete('/goals/:id',                    mgr,  ctrl.deleteGoal);

// Reviews
router.get('/reviews',                         auth, ctrl.getReviews);
router.get('/reviews/:id',                     auth, ctrl.getReview);
router.post('/reviews/:id/self-assessment',    auth, ctrl.submitSelfAssessment);
router.post('/reviews/:id/manager-review',     mgr,  ctrl.submitManagerReview);
router.post('/reviews/:id/complete',           hr,   ctrl.completeReview);

module.exports = router;