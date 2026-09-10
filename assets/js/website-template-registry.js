/*
 * Website template catalogue.
 * ------------------------------------------------------------
 * Each template pack may have different sections, copy, images and layout.
 * It does NOT own lending logic. Applications, authentication, Admin and
 * Client Portal remain in the KredRun core platform.
 */
(() => {
  window.KREDRUN_WEBSITE_TEMPLATES = Object.freeze({
    'clean-credit': {
      id: 'clean-credit',
      name: 'Clean Credit',
      status: 'ready',
      entry: '/index.html',
      description: 'Friendly modern lending site with calculator-led hero.',
      sections: ['calculator-hero', 'security-strip', 'benefits', 'how-it-works', 'faq', 'final-cta'],
      supportsTenantBrand: true
    }

    /*
     * Future packs are added here, for example:
     * 'corporate-trust': { entry:'/templates/corporate-trust/index.html', ... }
     * 'community-cash':  { entry:'/templates/community-cash/index.html', ... }
     *
     * A pack is allowed to use completely different sections and wording.
     * The only required integration points are Apply, Login and Account URLs.
     */
  });
})();
