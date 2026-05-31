const Car = require('../models/Car');
const Category = require('../models/Category');
const BRANDS = require('../config/carBrands');

class CarController {

  static index(req, res) {
    const cars = Car.findAll();
    res.render('cars/index', { t: req.t, cars });
  }

  static new(req, res) {
    const categories = Category.findAll();
    const lang = req.session?.lang || 'es';
    res.render('cars/form', { t: req.t, lang, car: null, categories, brands: BRANDS, error: null });
  }

  static getOrCreateCategory(categoryName) {
    const trimmed = categoryName.trim();
    let category = Category.findByName(trimmed);
    if (!category) {
      Category.create(trimmed);
      category = Category.findByName(trimmed);
    }
    return category;
  }

  static create(req, res) {
    const { brand, model, category_name, description } = req.body;
    const categories = Category.findAll();
    const lang = req.session?.lang || 'es';

    if (!brand || !brand.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car: null,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'La marca es requerida' : 'Brand is required'
      });
    }

    if (!model || !model.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car: null,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'El modelo es requerido' : 'Model is required'
      });
    }

    if (!category_name || !category_name.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car: null,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'La categoría es requerida' : 'Category is required'
      });
    }

    try {
      const category = CarController.getOrCreateCategory(category_name);
      Car.create(brand.trim(), model.trim(), category.id, description?.trim() || '');
      res.redirect('/cars');
    } catch (err) {
      res.render('cars/form', {
        t: req.t,
        lang,
        car: null,
        categories,
        brands: BRANDS,
        error: err.message || (lang === 'es' ? 'Error creando coche' : 'Error creating car')
      });
    }
  }

  static edit(req, res) {
    const car = Car.findById(parseInt(req.params.id, 10));
    if (!car) return res.status(404).render('error', { t: req.t, code: 404, message: 'Car not found' });

    const categories = Category.findAll();
    const lang = req.session?.lang || 'es';
    res.render('cars/form', { t: req.t, lang, car, categories, brands: BRANDS, error: null });
  }

  static update(req, res) {
    const { brand, model, category_name, description } = req.body;
    const id = parseInt(req.params.id, 10);
    const car = Car.findById(id);
    const categories = Category.findAll();
    const lang = req.session?.lang || 'es';

    if (!car) return res.status(404).render('error', { t: req.t, code: 404, message: 'Car not found' });

    if (!brand || !brand.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'La marca es requerida' : 'Brand is required'
      });
    }

    if (!model || !model.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'El modelo es requerido' : 'Model is required'
      });
    }

    if (!category_name || !category_name.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'La categoría es requerida' : 'Category is required'
      });
    }

    try {
      const category = CarController.getOrCreateCategory(category_name);
      Car.update(id, brand.trim(), model.trim(), category.id, description?.trim() || '');
      res.redirect('/cars');
    } catch (err) {
      res.render('cars/form', {
        t: req.t,
        lang,
        car,
        categories,
        brands: BRANDS,
        error: err.message || (lang === 'es' ? 'Error actualizando coche' : 'Error updating car')
      });
    }
  }

  static delete(req, res) {
    const id = parseInt(req.params.id, 10);
    const car = Car.findById(id);
    if (!car) return res.status(404).render('error', { t: req.t, code: 404, message: 'Car not found' });

    Car.delete(id);
    res.redirect('/cars');
  }

  // CSV con cabecera (es o en):
  //   marca,modelo,categoria,descripcion
  //   brand,model,category,description
  // Tolera: separador ',' o ';' (autodetect), comillas para campos con comas,
  // BOM UTF-8 al principio. Categorías inexistentes se crean al vuelo.
  static importCsv(req, res) {
    const lang = req.session?.lang || 'es';
    let raw = req.body.csv_content || '';
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    raw = raw.trim();
    if (!raw) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Fichero vacío' : 'Empty file' };
      return res.redirect('/cars');
    }

    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Sin filas válidas' : 'No valid rows' };
      return res.redirect('/cars');
    }

    const sep = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';

    let dataLines = lines;
    const first = lines[0].toLowerCase();
    if (first.startsWith('marca') || first.startsWith('brand')) dataLines = lines.slice(1);

    let imported = 0, skipped = 0;
    dataLines.forEach(line => {
      const cols = parseCsvLine(line, sep).map(c => c.trim());
      const brand = cols[0];
      const model = cols[1];
      const categoryName = cols[2];
      const description = cols[3] || '';

      if (!brand || !model || !categoryName) { skipped++; return; }
      try {
        const category = CarController.getOrCreateCategory(categoryName);
        Car.create(brand, model, category.id, description);
        imported++;
      } catch { skipped++; }
    });

    const parts = [];
    parts.push(lang === 'es' ? `${imported} coches importados` : `${imported} cars imported`);
    if (skipped > 0) parts.push(lang === 'es' ? `${skipped} omitidos` : `${skipped} skipped`);
    req.session.flash = {
      type: imported > 0 ? 'success' : 'error',
      text: parts.join(' · '),
    };
    res.redirect('/cars');
  }
}

// Parser CSV mínimo con soporte de comillas (subset RFC 4180).
function parseCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

module.exports = CarController;
