import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';

const BasketContext = createContext(null);

const EMPTY = { id: null, items: [], item_count: 0, subtotal_amount: '0.00', currency: 'USD' };

/** The signed-in user's basket, shared by the header badge, product pages and checkout. */
export function BasketProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [basket, setBasket] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return setBasket(EMPTY);
    setLoading(true);
    try {
      setBasket(await api.basket());
    } catch {
      // the badge simply stays as it was; pages that need the basket show their own error
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with the server on sign-in/out
    refresh();
  }, [refresh]);

  // Every mutation returns the full updated basket, which becomes the new state.
  const mutate = useCallback(async (call) => {
    const next = await call();
    setBasket(next);
    return next;
  }, []);

  const value = useMemo(
    () => ({
      basket,
      loading,
      refresh,
      clear: () => setBasket(EMPTY),
      add: (productId, quantity = 1) => mutate(() => api.addToBasket(productId, quantity)),
      setQuantity: (productId, quantity) => mutate(() => api.setQuantity(productId, quantity)),
      remove: (productId) => mutate(() => api.removeFromBasket(productId)),
      replace: setBasket,
    }),
    [basket, loading, refresh, mutate],
  );
  return <BasketContext.Provider value={value}>{children}</BasketContext.Provider>;
}

export function useBasket() {
  const ctx = useContext(BasketContext);
  if (!ctx) throw new Error('useBasket must be used inside <BasketProvider>');
  return ctx;
}
