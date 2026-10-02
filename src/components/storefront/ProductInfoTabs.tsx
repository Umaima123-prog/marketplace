"use client";

import { useState } from "react";

/**
 * The product information tabs below the buying section.
 *
 * A client component for one reason: switching tabs changes what is shown, and
 * that is local state. It fetches nothing and knows nothing about the catalog --
 * the description arrives as a prop, already read from MySQL by the server.
 *
 * PRESENTATIONAL ONLY, deliberately and visibly.
 *
 * Description shows the merchant's real product description. Comments and
 * Rating are empty states, because this project has no reviews or comments
 * backend: no table, no API, no moderation. They say "none yet" and offer no
 * way to add one, which is the honest rendering of a feature that does not
 * exist. Nothing here invents a count, a star, a reviewer or a date, and there
 * is no submission form -- a form that accepted input and dropped it would be
 * worse than no form at all.
 */
const TABS = [
  { id: "description", label: "Description" },
  { id: "comments", label: "Comments" },
  { id: "rating", label: "Rating" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function ProductInfoTabs({ descriptionHtml }: { descriptionHtml: string | null }) {
  // Description first: it is the tab with real content in it.
  const [active, setActive] = useState<TabId>("description");

  return (
    <div className="card storefront-card storefront-pdp-card">
      <div className="card-header storefront-pdp-tabhead p-0 border-bottom-0">
        <ul className="nav nav-tabs" role="tablist" aria-label="Product information">
          {TABS.map((tab) => (
            <li className="nav-item" key={tab.id}>
              <button
                type="button"
                id={`tab-${tab.id}`}
                className={`nav-link${active === tab.id ? " active" : ""}`}
                role="tab"
                aria-selected={active === tab.id}
                aria-controls={`panel-${tab.id}`}
                onClick={() => setActive(tab.id)}
              >
                {tab.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card-body">
        {/*
          Each panel stays mounted and is hidden with `hidden`, so the rendered
          description is in the document for a crawler and for find-in-page even
          while another tab is in front.
        */}
        <div
          id="panel-description"
          role="tabpanel"
          aria-labelledby="tab-description"
          hidden={active !== "description"}
        >
          {descriptionHtml ? (
            /*
              Shopify-authored HTML. It is rendered as markup because that is
              what a product description is, and it is trusted for exactly one
              reason: it comes from the merchant's own Shopify admin via the
              sync worker, never from a shopper. No user input reaches this.
            */
            <div
              className="storefront-description"
              dangerouslySetInnerHTML={{ __html: descriptionHtml }}
            />
          ) : (
            <p className="storefront-pdp-empty">No description available.</p>
          )}
        </div>

        <div
          id="panel-comments"
          role="tabpanel"
          aria-labelledby="tab-comments"
          hidden={active !== "comments"}
        >
          <p className="storefront-pdp-empty">No comments yet.</p>
        </div>

        <div
          id="panel-rating"
          role="tabpanel"
          aria-labelledby="tab-rating"
          hidden={active !== "rating"}
        >
          <p className="storefront-pdp-empty">No ratings yet.</p>
        </div>
      </div>
    </div>
  );
}
