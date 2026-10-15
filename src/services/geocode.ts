// Nominatim geocoding wrapper
export const searchLocation = async (query: string) => {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&countrycodes=in&format=json&limit=5`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'PayanamApp/1.0' } });
    return await res.json();
  } catch (error) {
    return [];
  }
};

export const reverseGeocode = async (lat: number, lng: number) => {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'PayanamApp/1.0' } });
    const data = await res.json();
    return data.display_name;
  } catch (error) {
    return "Unknown location";
  }
};
