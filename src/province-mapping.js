/**
 * Shopify sends Guatemalan addresses with ISO 3166-2:GT province codes.
 * CAEX uses its own 2-digit department codes (01-22).
 * This maps one to the other.
 *
 * Shopify may send either:
 *   - province_code: "GT" (country only) — rare
 *   - province_code: "GT-GU" or just "GU" (depends on version)
 *   - province: "Guatemala" or "Guatemala City" (full name) — most common fallback
 *
 * We handle all three cases.
 */

// Shopify ISO code (2-letter) → CAEX department code
export const ISO_TO_CAEX = {
    AVA: '01', // Alta Verapaz
    BVA: '02', // Baja Verapaz
    CHI: '03', // Chimaltenango
    CHQ: '04', // Chiquimula
    PRO: '05', // El Progreso
    ESC: '06', // Escuintla
    GUA: '07', // Guatemala
    HUE: '08', // Huehuetenango
    IZA: '09', // Izabal
    JAL: '10', // Jalapa
    JUT: '11', // Jutiapa
    PET: '12', // Petén
    QUE: '13', // Quetzaltenango
    QCH: '14', // Quiché
    RET: '15', // Retalhuleu
    SAC: '16', // Sacatepéquez
    SMA: '17', // San Marcos
    SRO: '18', // Santa Rosa
    SOL: '19', // Sololá
   SUCH: '20', // Suchitepéquez
    TOT: '21', // Totonicapán
    ZAC: '22', // Zacapa
};

// Department name (normalized) → CAEX department code
export const NAME_TO_CAEX = {
  'alta verapaz': '01',
  'baja verapaz': '02',
  chimaltenango: '03',
  chiquimula: '04',
  'el progreso': '05',
  progreso: '05',
  escuintla: '06',
  guatemala: '07',
  huehuetenango: '08',
  izabal: '09',
  jalapa: '10',
  jutiapa: '11',
  peten: '12',
  petén: '12',
  quetzaltenango: '13',
  quiche: '14',
  quiché: '14',
  retalhuleu: '15',
  sacatepequez: '16',
  sacatepéquez: '16',
  'san marcos': '17',
  'santa rosa': '18',
  solola: '19',
  sololá: '19',
  suchitepequez: '20',
  suchitepéquez: '20',
  totonicapan: '21',
  totonicapán: '21',
  zacapa: '22',
};

/**
 * Best-effort resolve of a Shopify address's province → CAEX department code.
 * Returns the 2-digit CAEX code or null if unresolvable.
 */
export function resolveDepartamento({ province, province_code }) {
  // Try ISO code first (cleanest)
  if (province_code) {
    const code = province_code.toUpperCase().replace(/^GT-?/, '');
    if (ISO_TO_CAEX[code]) return ISO_TO_CAEX[code];
  }

  // Fall back to name match
  if (province) {
    const normalized = province
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents for the lookup but keep accented keys too
      .trim();
    if (NAME_TO_CAEX[normalized]) return NAME_TO_CAEX[normalized];

    // Also try raw (with accents) in case it matches
    const raw = province.toLowerCase().trim();
    if (NAME_TO_CAEX[raw]) return NAME_TO_CAEX[raw];
  }

  return null;
}
