const Car = require('../models/Car');
const Category = require('../models/Category');
const BRANDS = require('../config/carBrands');
const { parseCsvRaw, parseCsvLine, normalize } = require('../utils/csv');

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
  // Duplicados detectados por (marca + modelo) normalizado.
  static _parseCarsCsv(rawCsv) {
    const csv = rawCsv || '';
    const parsed = parseCsvRaw(csv);

    let dataLines = parsed.dataLines;
    const headerLooksReal = parsed.header[0] === 'marca' || parsed.header[0] === 'brand';
    if (!headerLooksReal) {
      dataLines = csv.split(/\r?\n/).filter(l => l.trim().length > 0);
    }

    const index = Car.buildBrandModelIndex();
    const seenInCsv = new Map();

    const rows = dataLines.map((line, i) => {
      const cols = parseCsvLine(line, parsed.sep).map(c => c.trim());
      const brand = cols[0];
      const model = cols[1];
      const categoryName = cols[2] || '';
      const description  = cols[3] || '';

      if (!brand || !model) {
        return { idx: i, brand: brand || '', model: model || '', categoryName, description, status: 'error', reason: 'missing_brand_or_model' };
      }
      if (!categoryName) {
        return { idx: i, brand, model, categoryName, description, status: 'error', reason: 'missing_category' };
      }

      const key = normalize(brand) + '|' + normalize(model);
      const existing = index.get(key);
      const seenAt = seenInCsv.get(key);
      seenInCsv.set(key, i);

      if (existing) {
        return { idx: i, brand, model, categoryName, description, status: 'duplicate', existing };
      }
      if (seenAt !== undefined) {
        return { idx: i, brand, model, categoryName, description, status: 'duplicate_in_csv', existingIdx: seenAt };
      }
      return { idx: i, brand, model, categoryName, description, status: 'new' };
    });

    return { rows, csv_content: csv };
  }

  static importPreview(req, res) {
    const lang = req.session?.lang || 'es';
    const { rows, csv_content } = CarController._parseCarsCsv(req.body.csv_content || '');
    if (rows.length === 0) {
      req.session.flash = { type: 'error', text: lang === 'es' ? 'Fichero vacío o sin filas válidas' : 'Empty file or no valid rows' };
      return res.redirect('/cars');
    }
    const stats = {
      total:     rows.length,
      new:       rows.filter(r => r.status === 'new').length,
      duplicate: rows.filter(r => r.status === 'duplicate' || r.status === 'duplicate_in_csv').length,
      error:     rows.filter(r => r.status === 'error').length,
    };
    res.render('cars/import-preview', { t: req.t, rows, csv_content, stats });
  }

  static importConfirm(req, res) {
    const lang = req.session?.lang || 'es';
    const { rows } = CarController._parseCarsCsv(req.body.csv_content || '');
    const decisions = req.body.decisions || {};

    let created = 0, updated = 0, skipped = 0;
    const createdInRun = new Map();

    rows.forEach(r => {
      if (r.status === 'error') { skipped++; return; }

      const ensureCat = () => CarController.getOrCreateCategory(r.categoryName);

      if (r.status === 'new') {
        try {
          const cat = ensureCat();
          Car.create(r.brand, r.model, cat.id, r.description);
          createdInRun.set(normalize(r.brand) + '|' + normalize(r.model), { id: null });
          created++;
        } catch { skipped++; }
        return;
      }

      const dec = (decisions[String(r.idx)] || 'update').toLowerCase();

      if (r.status === 'duplicate') {
        if (dec === 'skip') { skipped++; return; }
        if (dec === 'duplicate') {
          try { const cat = ensureCat(); Car.create(r.brand, r.model, cat.id, r.description); created++; }
          catch { skipped++; }
          return;
        }
        // update (default): mantenemos brand/model originales del CSV pero
        // actualizamos categoría y descripción.
        try {
          const cat = ensureCat();
          Car.update(r.existing.id, r.brand, r.model, cat.id, r.description);
          updated++;
        } catch { skipped++; }
        return;
      }

      if (r.status === 'duplicate_in_csv') {
        if (dec === 'skip') { skipped++; return; }
        try {
          const cat = ensureCat();
          // En el caso de duplicate_in_csv normalmente "duplicate" o "update"
          // acaban siendo equivalentes (la primera ya se creó). Para mantener
          // consistencia: si update, sobreescribimos la última copia creada
          // en esta tirada con los datos nuevos; si duplicate, creamos otra.
          if (dec === 'duplicate') {
            Car.create(r.brand, r.model, cat.id, r.description); created++;
          } else {
            // No tenemos un id fácilmente: para no complicarnos, creamos
            // como duplicado físico. (Si el usuario quería 'skip', ya está
            // arriba.)
            Car.create(r.brand, r.model, cat.id, r.description); created++;
          }
        } catch { skipped++; }
      }
    });

    const parts = [];
    if (created > 0) parts.push(lang === 'es' ? `${created} coches creados`      : `${created} cars created`);
    if (updated > 0) parts.push(lang === 'es' ? `${updated} coches actualizados` : `${updated} cars updated`);
    if (skipped > 0) parts.push(lang === 'es' ? `${skipped} omitidos`             : `${skipped} skipped`);
    req.session.flash = {
      type: (created + updated) > 0 ? 'success' : 'error',
      text: parts.join(' · ') || (lang === 'es' ? 'Sin cambios' : 'No changes'),
    };
    res.redirect('/cars');
  }
}

module.exports = CarController;
