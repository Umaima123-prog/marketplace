import type { ReactNode } from "react";

import { Navbar } from "./Navbar";

/**
 * The storefront shell.
 *
 * AdminLTE's layout is driven entirely by body classes: `layout-top-nav` gives
 * a full-width page with a top navbar and no sidebar. A shopper has nothing to
 * navigate between -- there is one catalog -- so a sidebar would be furniture.
 * That class is applied in app/layout.tsx, where the <body> lives.
 */
export function StorefrontLayout({
  title,
  subtitle,
  breadcrumb,
  children,
}: {
  /**
   * Omit to suppress the page header entirely. The catalog page leads with a
   * hero that already names the store, and a "Catalog" heading above it would be
   * a second title saying less.
   */
  title?: string;
  subtitle?: string;
  breadcrumb?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="wrapper">
      <Navbar />

      <div className="content-wrapper" style={{ marginLeft: 0 }}>
        {title ? (
          <div className="content-header">
            <div className="container">
              <div className="row mb-2 align-items-center">
                <div className="col-sm-8">
                  <h1 className="m-0 h3">{title}</h1>
                  {subtitle ? <p className="text-muted mb-0">{subtitle}</p> : null}
                </div>
                {breadcrumb ? <div className="col-sm-4">{breadcrumb}</div> : null}
              </div>
            </div>
          </div>
        ) : null}

        <section className="content pt-3">
          <div className="container">{children}</div>
        </section>
      </div>

      <footer className="main-footer text-center" style={{ marginLeft: 0 }}>
        <small className="text-muted">
          Catalog data is synchronised from Shopify. Prices and availability are shown as of the
          last synchronisation.
        </small>
      </footer>
    </div>
  );
}
