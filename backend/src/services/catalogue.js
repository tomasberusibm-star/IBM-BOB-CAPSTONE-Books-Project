import { notFound } from '../errors.js';
import { productColumns, shapeProduct } from '../lib/productSql.js';

const SORTS = {
  title: 'p.title ASC, p.id',
  price_asc: 'p.price ASC, p.title ASC, p.id',
  price_desc: 'p.price DESC, p.title ASC, p.id',
  newest: 'p.published_on DESC NULLS LAST, p.id DESC',
  // Instant items first, then soonest tentative date, then items with no known date.
  delivery: `CASE WHEN p.stock_quantity IS NULL THEN 0
                   WHEN effective_delivery_date(p.stock_quantity, p.tentative_delivery_date, 0) IS NULL THEN 2
                   ELSE 1 END,
             effective_delivery_date(p.stock_quantity, p.tentative_delivery_date, 0), p.title ASC, p.id`,
};

export function createCatalogueService({ pool, config }) {
  const cols = productColumns(config.deliveryLeadDays);
  const lead = config.deliveryLeadDays;
  const page = (total, p, size) => ({ page: p, page_size: size, total_items: total, total_pages: Math.ceil(total / size) });

  return {
    async listCategories() {
      const { rows } = await pool.query(
        'SELECT id, parent_id, slug, name FROM categories ORDER BY sort_order, name, id',
      );
      const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
      const roots = [];
      for (const node of byId.values()) {
        const parent = node.parent_id === null ? null : byId.get(node.parent_id);
        (parent ? parent.children : roots).push(node);
      }
      return roots;
    },

    async listBrands() {
      const { rows } = await pool.query('SELECT id, slug, name FROM brands ORDER BY name, id');
      return rows;
    },

    /**
     * Filtered product listing.
     *   categoryId       limit to a category (and, unless includeSubcategories=false, its descendants)
     *   brands           brand slugs (any of)
     *   q                full-text search over title and description
     *   availableOnly    hide out-of-stock items
     *   deliverBy        YYYY-MM-DD: only items that can be delivered by that date
     *                    (instant items always qualify; unknown delivery dates never do)
     */
    async listProducts({ categoryId, includeSubcategories = true, brands, q, availableOnly, deliverBy, sort, page: pageNo, pageSize }) {
      const params = [];
      const add = (v) => {
        params.push(v);
        return `$${params.length}`;
      };
      const where = ['p.is_active'];
      let withClause = '';

      if (categoryId !== undefined) {
        const exists = await pool.query('SELECT 1 FROM categories WHERE id = $1', [categoryId]);
        if (exists.rowCount === 0) throw notFound();
        const id = add(categoryId);
        const sub = add(includeSubcategories);
        withClause = `WITH RECURSIVE tree AS (
            SELECT id FROM categories WHERE id = ${id}
            UNION ALL
            SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id WHERE ${sub}::boolean)`;
        where.push('p.id IN (SELECT pc.product_id FROM product_categories pc WHERE pc.category_id IN (SELECT id FROM tree))');
      }
      if (brands?.length) where.push(`b.slug = ANY(${add(brands)}::text[])`);
      if (q) where.push(`p.search @@ websearch_to_tsquery('english', ${add(q)})`);
      if (availableOnly) where.push('(p.stock_quantity IS NULL OR p.stock_quantity > 0)');
      if (deliverBy) {
        where.push(
          `(p.stock_quantity IS NULL OR effective_delivery_date(p.stock_quantity, p.tentative_delivery_date, ${lead}) <= ${add(deliverBy)}::date)`,
        );
      }

      const from = `FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${where.join(' AND ')}`;
      const { rows: count } = await pool.query(`${withClause} SELECT count(*)::int AS n ${from}`, params);
      const total = count[0].n;

      const limit = add(pageSize);
      const offset = add((pageNo - 1) * pageSize);
      const { rows } = await pool.query(
        `${withClause} SELECT ${cols} ${from} ORDER BY ${SORTS[sort] ?? SORTS.title} LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      return { ...page(total, pageNo, pageSize), items: rows.map((r) => shapeProduct(r, config.currency)) };
    },

    async getProduct(id) {
      const { rows } = await pool.query(
        `SELECT ${cols}, p.isbn13, p.description, p.published_on,
                b.id AS brand_id, b.slug AS brand_slug, b.name AS brand_name
           FROM products p JOIN brands b ON b.id = p.brand_id
          WHERE p.id = $1 AND p.is_active`,
        [id],
      );
      if (rows.length === 0) throw notFound();
      const r = rows[0];
      const { rows: cats } = await pool.query(
        `SELECT c.id, c.slug, c.name, pc.is_primary
           FROM product_categories pc JOIN categories c ON c.id = pc.category_id
          WHERE pc.product_id = $1 ORDER BY pc.is_primary DESC, c.name`,
        [id],
      );
      return {
        ...shapeProduct(r, config.currency),
        isbn13: r.isbn13,
        description: r.description,
        published_on: r.published_on,
        brand: { id: r.brand_id, slug: r.brand_slug, name: r.brand_name },
        categories: cats,
      };
    },

    async listRelated(productId, { relation, limit }) {
      const exists = await pool.query('SELECT 1 FROM products WHERE id = $1 AND is_active', [productId]);
      if (exists.rowCount === 0) throw notFound();
      const { rows } = await pool.query(
        `SELECT r.relation, ${cols}
           FROM related_products r JOIN products p ON p.id = r.related_product_id
          WHERE r.product_id = $1 AND p.is_active AND ($2::relation_type IS NULL OR r.relation = $2::relation_type)
          ORDER BY r.relation, r.sort_order, p.title, p.id
          LIMIT $3`,
        [productId, relation ?? null, limit],
      );
      return rows.map((r) => ({ relation: r.relation, product: shapeProduct(r, config.currency) }));
    },
  };
}
