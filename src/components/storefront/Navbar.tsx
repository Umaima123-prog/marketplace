import Link from "next/link";

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
    <nav className="main-header navbar navbar-expand navbar-white navbar-light border-bottom">
      <ul className="navbar-nav">
        <li className="nav-item">
          <Link className="nav-link font-weight-bold" href="/">
            Marketplace
          </Link>
        </li>
        <li className="nav-item d-none d-sm-inline-block">
          <Link className="nav-link" href="/">
            Catalog
          </Link>
        </li>
      </ul>

      <ul className="navbar-nav ml-auto">
        <li className="nav-item">
          {/*
            Cash on delivery is the only payment method (ARCHITECTURE §4), so it
            is stated in the chrome rather than discovered at checkout.
          */}
          <span className="nav-link text-muted">Cash on delivery</span>
        </li>
      </ul>
    </nav>
  );
}
