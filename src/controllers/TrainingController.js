const TrainingService = require('../services/TrainingService');
const TimingService   = require('../services/TimingService');

class TrainingController {

  // GET /training
  static index(req, res) {
    if (TrainingService.isActive) return res.redirect('/training/live');
    res.render('training/index', { t: req.t });
  }

  // POST /training/start
  static start(req, res) {
    if (TimingService.isRunning) {
      return res.status(409).render('error', {
        t: req.t, code: 409,
        message: req.t ? 'A race is already running' : 'A race is already running'
      });
    }
    const lanes = Math.max(1, Math.min(32, parseInt(req.body.lanes, 10) || 6));
    TrainingService.start(lanes);
    res.redirect('/training/live');
  }

  // POST /training/stop
  static stop(req, res) {
    TrainingService.stop();
    res.redirect('/training');
  }

  // GET /training/live
  static live(req, res) {
    if (!TrainingService.isActive) return res.redirect('/training');
    const lanes = TrainingService.getLanes();
    res.render('training/live', { t: req.t, lanes, startedAt: TrainingService.startedAt });
  }
}

module.exports = TrainingController;
