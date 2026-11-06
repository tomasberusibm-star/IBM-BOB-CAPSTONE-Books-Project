import { Router } from 'express';
import { requireAuth, wrap } from '../middleware.js';
import {
  categoryParams,
  productListQuery,
  productParams,
  recommendationsQuery,
  relatedQuery,
} from '../validation.js';

export function catalogueRoutes({ auth, catalogue, recommendations }) {
  const r = Router();

  r.get('/categories', wrap(async (_req, res) => {
    res.json({ items: await catalogue.listCategories() });
  }));

  r.get('/brands', wrap(async (_req, res) => {
    res.json({ items: await catalogue.listBrands() });
  }));

  r.get('/categories/:id/products', wrap(async (req, res) => {
    const { id } = categoryParams.parse(req.params);
    const q = productListQuery.parse(req.query);
    res.json(await catalogue.listProducts({
      categoryId: id,
      includeSubcategories: q.include_subcategories,
      brands: q.brand,
      q: q.q,
      availableOnly: q.available_only,
      deliverBy: q.deliver_by,
      sort: q.sort,
      page: q.page,
      pageSize: q.page_size,
    }));
  }));

  // Cross-category search: filter by brand and/or category in one call.
  r.get('/products', wrap(async (req, res) => {
    const q = productListQuery.parse(req.query);
    res.json(await catalogue.listProducts({
      categoryId: q.category_id,
      includeSubcategories: q.include_subcategories,
      brands: q.brand,
      q: q.q,
      availableOnly: q.available_only,
      deliverBy: q.deliver_by,
      sort: q.sort,
      page: q.page,
      pageSize: q.page_size,
    }));
  }));

  r.get('/products/:id', wrap(async (req, res) => {
    const { id } = productParams.parse(req.params);
    res.json(await catalogue.getProduct(id));
  }));

  r.get('/products/:id/related', wrap(async (req, res) => {
    const { id } = productParams.parse(req.params);
    const q = relatedQuery.parse(req.query);
    res.json({ items: await catalogue.listRelated(id, q) });
  }));

  r.get('/recommendations', requireAuth(auth), wrap(async (req, res) => {
    const { limit } = recommendationsQuery.parse(req.query);
    res.json({ items: await recommendations.forUser(req.user.id, limit) });
  }));

  return r;
}
