const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const crypto   = require('crypto');
const { body, validationResult } = require('express-validator');
const router   = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl     = require('../controllers/recruitment.controller');

const RESUME_DIR = process.env.RESUME_DIR || path.join(__dirname, '../../uploads/resumes');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RESUME_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const hash = crypto.randomBytes(12).toString('hex');
    cb(null, `${Date.now()}_${hash}${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf','application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mimetype);
    cb(ok ? null : new Error('Only PDF and Word files allowed'), ok);
  },
  limits: { fileSize: 5*1024*1024 },
});

const hr      = [authenticate, authorizeRoles('Admin','HR','Manager')];
const auth    = [authenticate];
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Stats & dashboard
router.get('/stats',                       hr,   ctrl.getStats);
router.get('/interviews/upcoming',         hr,   ctrl.getUpcomingInterviews);

// Job openings
router.get('/jobs',                        hr,   ctrl.getJobs);
router.post('/jobs',                       hr,
  [body('title').notEmpty().trim()],
  validate, ctrl.createJob);
router.put('/jobs/:id',                    hr,   ctrl.updateJob);

// Candidates
router.get('/jobs/:id/candidates',         hr,   ctrl.getJobCandidates);
router.post('/jobs/:id/candidates',        hr,
  (req, res, next) => upload.single('resume')(req, res, err => {
    if (err) return res.status(422).json({ success: false, message: err.message });
    next();
  }),
  [body('full_name').notEmpty(), body('email').isEmail()],
  validate, ctrl.addCandidate);

router.get('/candidates/:id',              hr,   ctrl.getCandidate);
router.patch('/candidates/:id/stage',      hr,
  [body('stage').notEmpty()],
  validate, ctrl.updateStage);
router.patch('/candidates/:id/rating',     hr,   ctrl.rateCandidate);
router.get('/candidates/:id/resume',       hr,   ctrl.downloadResume);

// Interviews
router.post('/candidates/:id/interviews',  hr,
  [body('scheduled_at').notEmpty(), body('interview_type').notEmpty()],
  validate, ctrl.scheduleInterview);
router.patch('/interviews/:id',            hr,   ctrl.updateInterview);

module.exports = router;