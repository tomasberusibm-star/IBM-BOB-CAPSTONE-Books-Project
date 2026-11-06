import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { Layout } from './components/Layout.jsx';
import { EmptyState } from './components/ui.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { BasketProvider } from './context/BasketContext.jsx';
import BasketPage from './pages/BasketPage.jsx';
import CataloguePage from './pages/CataloguePage.jsx';
import LandingPage from './pages/LandingPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import OrdersPage from './pages/OrdersPage.jsx';
import ProductPage from './pages/ProductPage.jsx';

/** Pages that need a signed-in user send visitors to /login and bring them back afterwards. */
export function RequireAuth({ children }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  return children;
}

function NotFound() {
  return (
    <EmptyState title="Page not found" action={<Link to="/" className="font-medium text-brand-700 underline">Back to the home page</Link>}>
      The page you are looking for does not exist.
    </EmptyState>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<LandingPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="books" element={<CataloguePage />} />
        <Route path="books/:id" element={<ProductPage />} />
        <Route path="basket" element={<BasketPage />} />
        <Route
          path="orders"
          element={
            <RequireAuth>
              <OrdersPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <BasketProvider>
          <AppRoutes />
        </BasketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
