/**
 * In-memory mock artisan dataset.
 * Used automatically when process.env.DATABASE_URL is not set.
 * Shape mirrors the `artisans` table in database/postgres.js.
 *
 * Covers three major Nigerian cities: Lagos, Port Harcourt, Abuja.
 */

// ---------------------------------------------------------------------------
// Area coordinates
// ---------------------------------------------------------------------------

const AREAS = {
  // Lagos
  'Ikeja':            { lat: 6.6018, lng: 3.3515 },
  'Allen':            { lat: 6.6059, lng: 3.3548 },
  'Victoria Island':  { lat: 6.4281, lng: 3.4219 },
  'Lekki':            { lat: 6.4698, lng: 3.5852 },
  'Yaba':             { lat: 6.5095, lng: 3.3711 },
  'Surulere':         { lat: 6.4926, lng: 3.3553 },
  'Ajah':             { lat: 6.4667, lng: 3.5667 },
  'Ikorodu':          { lat: 6.6196, lng: 3.5106 },
  'Gbagada':          { lat: 6.5535, lng: 3.3886 },
  'Maryland':         { lat: 6.5703, lng: 3.3658 },

  // Port Harcourt
  'GRA Port Harcourt':  { lat: 4.8156, lng: 7.0498 },
  'Rumuola':            { lat: 4.8242, lng: 7.0194 },
  'Trans-Amadi':        { lat: 4.8404, lng: 7.0253 },
  'D-Line':             { lat: 4.7824, lng: 7.0159 },
  'Rumuokoro':          { lat: 4.8549, lng: 7.0431 },
  'Rumuodara':          { lat: 4.8743, lng: 7.0361 },

  // Abuja
  'Wuse 2':       { lat: 9.0724, lng: 7.4891 },
  'Wuse':         { lat: 9.0764, lng: 7.4836 },
  'Garki':        { lat: 9.0528, lng: 7.4759 },
  'Maitama':      { lat: 9.0836, lng: 7.4980 },
  'Asokoro':      { lat: 9.0524, lng: 7.5310 },
  'Gwarinpa':     { lat: 9.1104, lng: 7.4177 },
  'Jabi':         { lat: 9.0854, lng: 7.4489 },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let idCounter = 1;

function artisan({
  name, category, location, rating,
  completed_jobs, available, average_response_time,
  price_range, description, phone,
}) {
  const coords = AREAS[location] || AREAS['Ikeja'];
  return {
    id:                     idCounter++,
    name,
    phone:                  phone || `234${Math.floor(700000000 + Math.random() * 99999999)}`,
    category,
    description:            description || `Experienced ${category} serving ${location} and nearby areas.`,
    rating,
    completed_jobs,
    location,
    latitude:               coords.lat,
    longitude:              coords.lng,
    available,
    average_response_time,  // minutes
    price_range,
  };
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

const mockArtisans = [
  // ── LAGOS — Electricians ─────────────────────────────────────────────────
  artisan({ name: 'John Electrical Services',  category: 'electrician', location: 'Ikeja',           rating: 4.9, completed_jobs: 312, available: true,  average_response_time: 10, price_range: '₦5,000 - ₦20,000' }),
  artisan({ name: 'Bright Fix Solutions',       category: 'electrician', location: 'Allen',           rating: 4.7, completed_jobs: 198, available: true,  average_response_time: 25, price_range: '₦6,000 - ₦18,000' }),
  artisan({ name: 'PowerLine Electricals',      category: 'electrician', location: 'Yaba',            rating: 4.3, completed_jobs: 87,  available: false, average_response_time: 60, price_range: '₦4,000 - ₦15,000' }),
  artisan({ name: 'Voltage Masters',            category: 'electrician', location: 'Surulere',        rating: 4.6, completed_jobs: 145, available: true,  average_response_time: 15, price_range: '₦5,500 - ₦17,000' }),
  artisan({ name: 'Spark & Sons Electrical',    category: 'electrician', location: 'Victoria Island', rating: 4.8, completed_jobs: 260, available: true,  average_response_time: 20, price_range: '₦8,000 - ₦25,000' }),

  // ── LAGOS — Plumbers ─────────────────────────────────────────────────────
  artisan({ name: 'AquaFlow Plumbing',          category: 'plumber', location: 'Ikeja',    rating: 4.8, completed_jobs: 220, available: true,  average_response_time: 12, price_range: '₦4,000 - ₦16,000' }),
  artisan({ name: 'PipeMasters NG',             category: 'plumber', location: 'Lekki',    rating: 4.5, completed_jobs: 134, available: true,  average_response_time: 30, price_range: '₦5,000 - ₦19,000' }),
  artisan({ name: 'CleanWater Plumbing Co',     category: 'plumber', location: 'Ajah',     rating: 4.2, completed_jobs: 76,  available: false, average_response_time: 90, price_range: '₦3,500 - ₦14,000' }),
  artisan({ name: 'Drain Doctors',              category: 'plumber', location: 'Surulere', rating: 4.6, completed_jobs: 158, available: true,  average_response_time: 18, price_range: '₦4,500 - ₦17,500' }),

  // ── LAGOS — Mechanics ────────────────────────────────────────────────────
  artisan({ name: 'AutoFix Mechanics',          category: 'mechanic', location: 'Ikeja',           rating: 4.7, completed_jobs: 301, available: true,  average_response_time: 20,  price_range: '₦6,000 - ₦40,000' }),
  artisan({ name: 'Engine Doctors Garage',      category: 'mechanic', location: 'Gbagada',         rating: 4.4, completed_jobs: 112, available: true,  average_response_time: 35,  price_range: '₦7,000 - ₦35,000' }),
  artisan({ name: 'RoadReady Auto Care',        category: 'mechanic', location: 'Maryland',        rating: 4.1, completed_jobs: 64,  available: false, average_response_time: 120, price_range: '₦5,000 - ₦30,000' }),
  artisan({ name: 'TopGear Mechanics',          category: 'mechanic', location: 'Victoria Island', rating: 4.9, completed_jobs: 410, available: true,  average_response_time: 15,  price_range: '₦10,000 - ₦60,000' }),

  // ── LAGOS — Cleaners ─────────────────────────────────────────────────────
  artisan({ name: 'SparklingHome Cleaners',     category: 'cleaner', location: 'Lekki',    rating: 4.8, completed_jobs: 245, available: true,  average_response_time: 25,  price_range: '₦8,000 - ₦25,000' }),
  artisan({ name: 'TidyUp Cleaning Services',   category: 'cleaner', location: 'Yaba',     rating: 4.3, completed_jobs: 90,  available: true,  average_response_time: 40,  price_range: '₦5,000 - ₦18,000' }),
  artisan({ name: 'FreshStart Cleaners',        category: 'cleaner', location: 'Ikorodu',  rating: 4.0, completed_jobs: 52,  available: false, average_response_time: 100, price_range: '₦4,000 - ₦15,000' }),
  artisan({ name: 'CrystalClean Pro',           category: 'cleaner', location: 'Ikeja',    rating: 4.6, completed_jobs: 178, available: true,  average_response_time: 18,  price_range: '₦6,500 - ₦20,000' }),

  // ── LAGOS — Technicians ──────────────────────────────────────────────────
  artisan({ name: 'GadgetFix Technicians',      category: 'technician', location: 'Allen',           rating: 4.5, completed_jobs: 133, available: true,  average_response_time: 22, price_range: '₦3,000 - ₦20,000' }),
  artisan({ name: 'CoolAir AC Technicians',     category: 'technician', location: 'Victoria Island', rating: 4.9, completed_jobs: 289, available: true,  average_response_time: 15, price_range: '₦7,000 - ₦35,000' }),
  artisan({ name: 'ApplianceCare Experts',      category: 'technician', location: 'Surulere',        rating: 4.2, completed_jobs: 70,  available: false, average_response_time: 80, price_range: '₦4,000 - ₦22,000' }),

  // ── LAGOS — Carpenters & Painters ────────────────────────────────────────
  artisan({ name: 'WoodCraft Carpentry',        category: 'carpenter', location: 'Gbagada',  rating: 4.6, completed_jobs: 120, available: true,  average_response_time: 30, price_range: '₦5,000 - ₦45,000' }),
  artisan({ name: 'Master Builders Carpentry',  category: 'carpenter', location: 'Ikeja',    rating: 4.4, completed_jobs: 95,  available: true,  average_response_time: 35, price_range: '₦6,000 - ₦50,000' }),
  artisan({ name: 'ColorPro Painters',          category: 'painter',   location: 'Lekki',    rating: 4.7, completed_jobs: 160, available: true,  average_response_time: 28, price_range: '₦10,000 - ₦60,000' }),
  artisan({ name: 'FreshCoat Painting Services',category: 'painter',   location: 'Yaba',     rating: 4.1, completed_jobs: 58,  available: false, average_response_time: 90, price_range: '₦8,000 - ₦45,000' }),

  // ═════════════════════════════════════════════════════════════════════════
  // PORT HARCOURT
  // ═════════════════════════════════════════════════════════════════════════

  // Electricians
  artisan({ name: 'PH PowerTech Electricals',   category: 'electrician', location: 'GRA Port Harcourt', rating: 4.8, completed_jobs: 180, available: true,  average_response_time: 15, price_range: '₦5,000 - ₦22,000' }),
  artisan({ name: 'Niger Delta Electric',        category: 'electrician', location: 'Trans-Amadi',       rating: 4.5, completed_jobs: 130, available: true,  average_response_time: 25, price_range: '₦4,500 - ₦18,000' }),
  artisan({ name: 'Rumuola Wiring Experts',      category: 'electrician', location: 'Rumuola',           rating: 4.3, completed_jobs: 75,  available: false, average_response_time: 50, price_range: '₦4,000 - ₦15,000' }),
  artisan({ name: 'D-Line Electrical Services',  category: 'electrician', location: 'D-Line',            rating: 4.6, completed_jobs: 110, available: true,  average_response_time: 20, price_range: '₦5,000 - ₦20,000' }),

  // Plumbers
  artisan({ name: 'PH PipePros',                 category: 'plumber', location: 'GRA Port Harcourt', rating: 4.7, completed_jobs: 145, available: true,  average_response_time: 18, price_range: '₦4,000 - ₦17,000' }),
  artisan({ name: 'RiverState Plumbing Co',       category: 'plumber', location: 'Rumuokoro',         rating: 4.4, completed_jobs: 93,  available: true,  average_response_time: 30, price_range: '₦3,500 - ₦15,000' }),
  artisan({ name: 'Trans-Amadi Drainage Experts', category: 'plumber', location: 'Trans-Amadi',       rating: 4.2, completed_jobs: 60,  available: false, average_response_time: 70, price_range: '₦3,000 - ₦13,000' }),

  // Mechanics
  artisan({ name: 'PH Auto Clinic',              category: 'mechanic', location: 'Trans-Amadi',       rating: 4.8, completed_jobs: 270, available: true,  average_response_time: 20, price_range: '₦8,000 - ₦50,000' }),
  artisan({ name: 'GRA Motor Doctors',           category: 'mechanic', location: 'GRA Port Harcourt', rating: 4.6, completed_jobs: 190, available: true,  average_response_time: 25, price_range: '₦7,000 - ₦45,000' }),
  artisan({ name: 'D-Line Auto Repairs',         category: 'mechanic', location: 'D-Line',            rating: 4.3, completed_jobs: 88,  available: false, average_response_time: 60, price_range: '₦5,000 - ₦35,000' }),

  // Cleaners
  artisan({ name: 'PH SparkleClean',             category: 'cleaner', location: 'GRA Port Harcourt', rating: 4.7, completed_jobs: 162, available: true,  average_response_time: 30, price_range: '₦7,000 - ₦22,000' }),
  artisan({ name: 'Rumuola Home Cleaners',        category: 'cleaner', location: 'Rumuola',           rating: 4.2, completed_jobs: 55,  available: true,  average_response_time: 45, price_range: '₦5,000 - ₦16,000' }),

  // Technicians
  artisan({ name: 'PH CoolTech AC Services',     category: 'technician', location: 'GRA Port Harcourt', rating: 4.9, completed_jobs: 210, available: true,  average_response_time: 20, price_range: '₦6,000 - ₦30,000' }),
  artisan({ name: 'Trans-Amadi Gadget Repair',   category: 'technician', location: 'Trans-Amadi',       rating: 4.4, completed_jobs: 99,  available: true,  average_response_time: 35, price_range: '₦3,000 - ₦18,000' }),

  // Carpenters & Painters
  artisan({ name: 'PH WoodWorks',                category: 'carpenter', location: 'Rumuodara',         rating: 4.5, completed_jobs: 88,  available: true,  average_response_time: 40, price_range: '₦6,000 - ₦40,000' }),
  artisan({ name: 'GRA PaintPerfect',            category: 'painter',   location: 'GRA Port Harcourt', rating: 4.7, completed_jobs: 120, available: true,  average_response_time: 35, price_range: '₦10,000 - ₦55,000' }),

  // ═════════════════════════════════════════════════════════════════════════
  // ABUJA
  // ═════════════════════════════════════════════════════════════════════════

  // Electricians
  artisan({ name: 'Wuse Electrical Experts',     category: 'electrician', location: 'Wuse 2',   rating: 4.9, completed_jobs: 240, available: true,  average_response_time: 12, price_range: '₦6,000 - ₦25,000' }),
  artisan({ name: 'Maitama PowerFix',            category: 'electrician', location: 'Maitama',  rating: 4.7, completed_jobs: 175, available: true,  average_response_time: 20, price_range: '₦7,000 - ₦28,000' }),
  artisan({ name: 'Garki Wiring Solutions',      category: 'electrician', location: 'Garki',    rating: 4.4, completed_jobs: 110, available: false, average_response_time: 45, price_range: '₦5,000 - ₦20,000' }),
  artisan({ name: 'Gwarinpa Electric Co',        category: 'electrician', location: 'Gwarinpa', rating: 4.5, completed_jobs: 140, available: true,  average_response_time: 30, price_range: '₦5,500 - ₦22,000' }),

  // Plumbers
  artisan({ name: 'Abuja Pipe Solutions',        category: 'plumber', location: 'Wuse 2',   rating: 4.8, completed_jobs: 200, available: true,  average_response_time: 15, price_range: '₦5,000 - ₦20,000' }),
  artisan({ name: 'FCT Drainage Masters',        category: 'plumber', location: 'Garki',    rating: 4.5, completed_jobs: 115, available: true,  average_response_time: 25, price_range: '₦4,000 - ₦17,000' }),
  artisan({ name: 'Asokoro Plumbing Pros',       category: 'plumber', location: 'Asokoro',  rating: 4.3, completed_jobs: 80,  available: false, average_response_time: 60, price_range: '₦5,500 - ₦18,000' }),

  // Mechanics
  artisan({ name: 'Jabi Auto Workshop',          category: 'mechanic', location: 'Jabi',     rating: 4.7, completed_jobs: 290, available: true,  average_response_time: 20, price_range: '₦8,000 - ₦55,000' }),
  artisan({ name: 'Wuse Motor Clinic',           category: 'mechanic', location: 'Wuse 2',   rating: 4.8, completed_jobs: 350, available: true,  average_response_time: 15, price_range: '₦10,000 - ₦65,000' }),
  artisan({ name: 'Gwarinpa Garage Services',    category: 'mechanic', location: 'Gwarinpa', rating: 4.2, completed_jobs: 78,  available: false, average_response_time: 80, price_range: '₦6,000 - ₦40,000' }),

  // Cleaners
  artisan({ name: 'Maitama Clean Homes',         category: 'cleaner', location: 'Maitama',  rating: 4.9, completed_jobs: 198, available: true,  average_response_time: 25, price_range: '₦10,000 - ₦30,000' }),
  artisan({ name: 'FCT TidyPro Cleaners',        category: 'cleaner', location: 'Wuse 2',   rating: 4.5, completed_jobs: 120, available: true,  average_response_time: 35, price_range: '₦7,000 - ₦22,000' }),
  artisan({ name: 'Asokoro Home Services',       category: 'cleaner', location: 'Asokoro',  rating: 4.6, completed_jobs: 145, available: true,  average_response_time: 30, price_range: '₦8,000 - ₦25,000' }),

  // Technicians
  artisan({ name: 'Abuja CoolBreeze AC',         category: 'technician', location: 'Wuse 2',   rating: 4.8, completed_jobs: 230, available: true,  average_response_time: 20, price_range: '₦7,000 - ₦35,000' }),
  artisan({ name: 'Maitama GadgetCare',          category: 'technician', location: 'Maitama',  rating: 4.6, completed_jobs: 150, available: true,  average_response_time: 25, price_range: '₦4,000 - ₦25,000' }),
  artisan({ name: 'Garki AppliFix',              category: 'technician', location: 'Garki',    rating: 4.3, completed_jobs: 85,  available: false, average_response_time: 70, price_range: '₦3,500 - ₦20,000' }),

  // Carpenters & Painters
  artisan({ name: 'FCT Furniture Masters',       category: 'carpenter', location: 'Gwarinpa', rating: 4.6, completed_jobs: 105, available: true,  average_response_time: 40, price_range: '₦7,000 - ₦55,000' }),
  artisan({ name: 'Maitama Fine Carpentry',      category: 'carpenter', location: 'Maitama',  rating: 4.8, completed_jobs: 160, available: true,  average_response_time: 30, price_range: '₦9,000 - ₦70,000' }),
  artisan({ name: 'Wuse PaintPros',              category: 'painter',   location: 'Wuse 2',   rating: 4.7, completed_jobs: 140, available: true,  average_response_time: 35, price_range: '₦12,000 - ₦65,000' }),
  artisan({ name: 'Garki Color Studio',          category: 'painter',   location: 'Garki',    rating: 4.4, completed_jobs: 90,  available: false, average_response_time: 90, price_range: '₦9,000 - ₦50,000' }),
];

module.exports = { mockArtisans, AREAS };
