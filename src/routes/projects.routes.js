const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/projects.controller');

const mgr  = [authenticate, authorizeRoles('Admin','HR','Manager')];
const auth = [authenticate];

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success:false, errors:errs.array() });
  next();
};

// Dashboard & self
router.get('/stats',                        auth, ctrl.getStats);
router.get('/my-tasks',                     auth, ctrl.getMyTasks);

// Projects
router.get('/',                             auth, ctrl.getProjects);
router.get('/:id',                          auth, ctrl.getProject);
router.post('/',
  mgr,
  [body('name').notEmpty().trim()],
  validate, ctrl.createProject
);
router.put('/:id',                          mgr,  ctrl.updateProject);

// Members
router.post('/:id/members',                 mgr,
  [body('employee_id').notEmpty()],
  validate, ctrl.addMember
);
router.delete('/:id/members/:empId',        mgr,  ctrl.removeMember);

// Milestones
router.post('/:id/milestones',              mgr,
  [body('title').notEmpty()],
  validate, ctrl.addMilestone
);
router.patch('/milestones/:id/complete',    mgr,  ctrl.completeMilestone);

// Tasks
router.get('/:id/tasks',                    auth, ctrl.getTasks);
router.post('/:id/tasks',
  auth,
  [body('title').notEmpty().trim()],
  validate, ctrl.createTask
);

// Individual task ops
router.get('/tasks/:id',                    auth, ctrl.getTask);
router.patch('/tasks/:id',                  auth, ctrl.updateTask);
router.patch('/tasks/:id/move',             auth, ctrl.moveTask);
router.delete('/tasks/:id',                 mgr,  ctrl.deleteTask);
router.post('/tasks/:id/comments',          auth,
  [body('comment').notEmpty()],
  validate, ctrl.addComment
);
router.post('/tasks/:id/time-log',          auth,
  [body('hours').isNumeric()],
  validate, ctrl.logTime
);

module.exports = router;