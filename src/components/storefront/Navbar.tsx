import Link from "next/link";

import { CartBadge } from "@/src/components/cart/CartBadge";

/**
 * AdminLTE's navbar, expressed as JSX.
 *
 * AdminLTE's own navbar markup carries `data-widget` attributes that its jQuery
 * plugins bind to (push-menu, fullscreen, the dropdown toggles). None of that is
 * loaded here, so those attributes are omitted rather than copied: an attribute
 * whose behaviour never arrives is a control that silently does nothing.
 *
 * What remains is the AdminLTE class vocabulary -- which is pure CSS -- with
 * real links.
 */
export function Navbar() {
  return (
    <nav className="main-header navbar navbar-expand navbar-white navbar-light border-bottom storefront-navbar">
      <div className="container">
        <ul className="navbar-nav">
          <li className="nav-item">
            <Link className="nav-link storefront-brand" href="/">
              {/*
                A monogram tile rather than an image: the store has no logo
                asset, and inventing one as a file would be a binary in the
                repository that nothing can regenerate.
              */}
              <span className="storefront-brand-mark" aria-hidden="true">
                M
              </span>
              Marketplace
            </Link>
          </li>
          <li className="nav-item d-none d-sm-inline-block">
            <Link className="nav-link" href="/">
              Electronics
            </Link>
          </li>
        </ul>

        <ul className="navbar-nav ml-auto align-items-center">
          <li className="nav-item d-none d-md-inline-block mr-2">
            {/*
              Cash on delivery is the only payment method (ARCHITECTURE §4), so
              it is stated in the chrome rather than discovered at checkout.
            */}
            <span className="storefront-cod-chip">Cash on delivery</span>
          </li>
          <li className="nav-item">
            {/* The only client component in the navbar: the count lives in the
                shopper's browser, so the server cannot render it. */}
            <CartBadge />
          </li>
        </ul>
      </div>
    </nav>
  );
}
