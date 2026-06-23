/**
 * In-memory mock artisan dataset.
 * Used automatically when process.env.DATABASE_URL is not set (see config/index.js).
 * Shape mirrors the `artisans` table defined in database/postgres.js so that
 * swapping to real PostgreSQL later requires no changes to ranking.js or artisanService.js.
 */

// Approximate coordinates for well-known Lagos areas, used for distance scoring.
const AREAS = {
  Ikeja: { lat: 6.6018, lng: 3.3515 },
  Allen: { lat: 6.6059, lng: 3.3548 },
  'Victoria Island': { lat: 6.4281, lng: 3.4219 },
  Lekki: { lat: 6.4698, lng: 3.5852 },
  Yaba: { lat: 6.5095, lng: 3.3711 },
  Surulere: { lat: 6.4926, lng: 3.3553 },
  Ajah: { lat: 6.4667, lng: 3.5667 },
  Ikorodu: { lat: 6.6196, lng: 3.5106 },
  Gbagada: { lat: 6.5535, lng: 3.3886 },
  Maryland: { lat: 6.5703, lng: 3.3658 },
};

let idCounter = 1;
function nextId() {
  return idCounter++;
}

function artisan({
  name,
  category,
  location,
  rating,
  completed_jobs,
  available,
  average_response_time,
  price_range,
  description,
  phone,
}) {
  const coords = AREAS[location] || AREAS.Ikeja;
  return {
    id: nextId(),
    name,
    phone: phone || `234${Math.floor(700000000 + Math.random() * 99999999)}`,
    category,
    description: description || `Experienced ${category} serving ${location} and nearby areas.`,
    rating,
    completed_jobs,
    location,
    latitude: coords.lat,
    longitude: coords.lng,
    available,
    average_response_time, // in minutes
    price_range, // e.g. "₦5,000 - ₦15,000"
  };
}

const mockArtisans = [
  artisan({ name: 'John Electrical Services', category: 'electrician', location: 'Ikeja', rating: 4.9, completed_jobs: 312, available: true, average_response_time: 10, price_range: '₦5,000 - ₦20,000' }),
  artisan({ name: 'Bright Fix Solutions', category: 'electrician', location: 'Allen', rating: 4.7, completed_jobs: 198, available: true, average_response_time: 25, price_range: '₦6,000 - ₦18,000' }),
  artisan({ name: 'PowerLine Electricals', category: 'electrician', location: 'Yaba', rating: 4.3, completed_jobs: 87, available: false, average_response_time: 60, price_range: '₦4,000 - ₦15,000' }),
  artisan({ name: 'Voltage Masters', category: 'electrician', location: 'Surulere', rating: 4.6, completed_jobs: 145, available: true, average_response_time: 15, price_range: '₦5,500 - ₦17,000' }),
  artisan({ name: 'Spark & Sons Electrical', category: 'electrician', location: 'Victoria Island', rating: 4.8, completed_jobs: 260, available: true, average_response_time: 20, price_range: '₦8,000 - ₦25,000' }),

  artisan({ name: 'AquaFlow Plumbing', category: 'plumber', location: 'Ikeja', rating: 4.8, completed_jobs: 220, available: true, average_response_time: 12, price_range: '₦4,000 - ₦16,000' }),
  artisan({ name: 'PipeMasters NG', category: 'plumber', location: 'Lekki', rating: 4.5, completed_jobs: 134, available: true, average_response_time: 30, price_range: '₦5,000 - ₦19,000' }),
  artisan({ name: 'CleanWater Plumbing Co', category: 'plumber', location: 'Ajah', rating: 4.2, completed_jobs: 76, available: false, average_response_time: 90, price_range: '₦3,500 - ₦14,000' }),
  artisan({ name: 'Drain Doctors', category: 'plumber', location: 'Surulere', rating: 4.6, completed_jobs: 158, available: true, average_response_time: 18, price_range: '₦4,500 - ₦17,500' }),

  artisan({ name: 'AutoFix Mechanics', category: 'mechanic', location: 'Ikeja', rating: 4.7, completed_jobs: 301, available: true, average_response_time: 20, price_range: '₦6,000 - ₦40,000' }),
  artisan({ name: 'Engine Doctors Garage', category: 'mechanic', location: 'Gbagada', rating: 4.4, completed_jobs: 112, available: true, average_response_time: 35, price_range: '₦7,000 - ₦35,000' }),
  artisan({ name: 'RoadReady Auto Care', category: 'mechanic', location: 'Maryland', rating: 4.1, completed_jobs: 64, available: false, average_response_time: 120, price_range: '₦5,000 - ₦30,000' }),
  artisan({ name: 'TopGear Mechanics', category: 'mechanic', location: 'Victoria Island', rating: 4.9, completed_jobs: 410, available: true, average_response_time: 15, price_range: '₦10,000 - ₦60,000' }),

  artisan({ name: 'SparklingHome Cleaners', category: 'cleaner', location: 'Lekki', rating: 4.8, completed_jobs: 245, available: true, average_response_time: 25, price_range: '₦8,000 - ₦25,000' }),
  artisan({ name: 'TidyUp Cleaning Services', category: 'cleaner', location: 'Yaba', rating: 4.3, completed_jobs: 90, available: true, average_response_time: 40, price_range: '₦5,000 - ₦18,000' }),
  artisan({ name: 'FreshStart Cleaners', category: 'cleaner', location: 'Ikorodu', rating: 4.0, completed_jobs: 52, available: false, average_response_time: 100, price_range: '₦4,000 - ₦15,000' }),
  artisan({ name: 'CrystalClean Pro', category: 'cleaner', location: 'Ikeja', rating: 4.6, completed_jobs: 178, available: true, average_response_time: 18, price_range: '₦6,500 - ₦20,000' }),

  artisan({ name: 'GadgetFix Technicians', category: 'technician', location: 'Allen', rating: 4.5, completed_jobs: 133, available: true, average_response_time: 22, price_range: '₦3,000 - ₦20,000' }),
  artisan({ name: 'CoolAir AC Technicians', category: 'technician', location: 'Victoria Island', rating: 4.9, completed_jobs: 289, available: true, average_response_time: 15, price_range: '₦7,000 - ₦35,000' }),
  artisan({ name: 'ApplianceCare Experts', category: 'technician', location: 'Surulere', rating: 4.2, completed_jobs: 70, available: false, average_response_time: 80, price_range: '₦4,000 - ₦22,000' }),

  artisan({ name: 'WoodCraft Carpentry', category: 'carpenter', location: 'Gbagada', rating: 4.6, completed_jobs: 120, available: true, average_response_time: 30, price_range: '₦5,000 - ₦45,000' }),
  artisan({ name: 'Master Builders Carpentry', category: 'carpenter', location: 'Ikeja', rating: 4.4, completed_jobs: 95, available: true, average_response_time: 35, price_range: '₦6,000 - ₦50,000' }),

  artisan({ name: 'ColorPro Painters', category: 'painter', location: 'Lekki', rating: 4.7, completed_jobs: 160, available: true, average_response_time: 28, price_range: '₦10,000 - ₦60,000' }),
  artisan({ name: 'FreshCoat Painting Services', category: 'painter', location: 'Yaba', rating: 4.1, completed_jobs: 58, available: false, average_response_time: 90, price_range: '₦8,000 - ₦45,000' }),
];

module.exports = { mockArtisans, AREAS };
