import express from 'express';
import { searchLocation, reverseGeocode } from '../services/geocode.js';

export const geocodeRouter = express.Router();

geocodeRouter.get('/search', async (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q) return res.json({ data: [] });
    
    const results = await searchLocation(q);
    res.json({ data: results });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'GEOCODE_ERROR', message: err.message } });
  }
});

geocodeRouter.get('/reverse', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: { message: "Invalid coordinates" } });
    
    const address = await reverseGeocode(lat, lng);
    res.json({ data: address });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'GEOCODE_ERROR', message: err.message } });
  }
});
