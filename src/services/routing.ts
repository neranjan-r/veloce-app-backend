// OSRM routing service
export const getRoute = async (points: [number, number][]) => {
  if (points.length < 2) throw new Error("At least 2 points required");
  
  const coordinates = points.map(p => `${p[1]},${p[0]}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`;
  
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error(data.message);
    
    const route = data.routes[0];
    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometry: route.geometry,
    };
  } catch (error) {
    console.error("Routing error:", error);
    // Mock fallback
    return { distanceMeters: 5000, durationSeconds: 600, geometry: null };
  }
};
