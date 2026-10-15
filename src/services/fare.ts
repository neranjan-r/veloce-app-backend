export const calculateFare = (
  distanceMeters: number, 
  durationSeconds: number, 
  vehicleType: string, 
  surgeMultiplier: number = 1.0
) => {
  const km = distanceMeters / 1000;
  const minutes = durationSeconds / 60;
  
  let base = 0;
  let perKm = 0;
  let perMinute = 0;
  let minFare = 0;

  switch (vehicleType) {
    case 'BIKE':
      base = 2000; perKm = 600; perMinute = 100; minFare = 3000;
      break;
    case 'AUTO':
      base = 3000; perKm = 900; perMinute = 150; minFare = 5000;
      break;
    case 'CAB':
    case 'Veloce X':
    case 'VELOCE_X':
      base = 5000; perKm = 1400; perMinute = 200; minFare = 8000;
      break;
    default:
      base = 5000; perKm = 1400; perMinute = 200; minFare = 8000;
  }

  let fare = base + (perKm * km) + (perMinute * minutes);
  fare = fare * surgeMultiplier;
  
  return Math.max(Math.round(fare), minFare);
};
