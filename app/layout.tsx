import type { Metadata } from "next";

// Order matters: Bootstrap, then AdminLTE's overrides, then ours.
// AdminLTE is vendored (vendor/adminlte/adminlte.min.css) rather than installed
// -- see the header of that file for why.
import "bootstrap/dist/css/bootstrap.min.css";
import "@/vendor/adminlte/adminlte.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Marketplace",
  description: "Cash-on-delivery storefront",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/*
        AdminLTE's layout is driven by body classes rather than by its
        JavaScript. `layout-top-nav` is the full-width, no-sidebar variant --
        the right shape for a storefront, where a shopper has one catalog to
        browse and nothing to navigate between.
      */}
      <body className="layout-top-nav">{children}</body>
    </html>
  );
}
