import PDFDocument from 'pdfkit';

export interface ReceiptData {
  id: string;
  receiptNumber: string;
  date: Date;
  riderName: string;
  driverName: string;
  vehicleType: string;
  vehicleModel?: string | null;
  plateNumber?: string | null;
  pickupAddress: string;
  dropAddress: string;
  distanceKm: string;
  durationMins: number;
  fareRupees: number;
  paymentMethod: string;
  paymentStatus: string;
}

export function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers: Buffer[] = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // Header Branding
    doc.fillColor('#111111').fontSize(24).font('Helvetica-Bold').text('VELOCE', { align: 'left' });
    doc.fillColor('#d4af37').fontSize(10).font('Helvetica').text('PRIVATE CHAUFFEUR & MOBILITY', { align: 'left' });
    doc.moveDown();

    doc.strokeColor('#e5e5e5').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();

    // Receipt Meta
    doc.fillColor('#333333').fontSize(14).font('Helvetica-Bold').text('TRIP RECEIPT');
    doc.fillColor('#666666').fontSize(10).font('Helvetica');
    doc.text(`Receipt Number: ${data.receiptNumber}`);
    doc.text(`Date & Time: ${data.date.toLocaleString('en-IN')}`);
    doc.text(`Passenger: ${data.riderName}`);
    doc.moveDown();

    // Journey Details
    doc.fillColor('#111111').fontSize(12).font('Helvetica-Bold').text('Journey Summary');
    doc.fillColor('#444444').fontSize(10).font('Helvetica');
    doc.text(`Origin: ${data.pickupAddress}`);
    doc.text(`Destination: ${data.dropAddress}`);
    doc.text(`Distance: ${data.distanceKm} km | Duration: ${data.durationMins} mins`);
    doc.text(`Vehicle: ${data.vehicleType} (${data.vehicleModel || 'Mercedes-Benz E-Class'})`);
    doc.text(`Chauffeur: ${data.driverName} • Plate: ${data.plateNumber || 'DL 01 AB 1234'}`);
    doc.moveDown();

    doc.strokeColor('#e5e5e5').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();

    // Financial Breakdown
    const baseFare = Math.round(data.fareRupees * 0.7);
    const distanceFare = Math.round(data.fareRupees * 0.2);
    const taxes = data.fareRupees - baseFare - distanceFare;

    doc.fillColor('#111111').fontSize(12).font('Helvetica-Bold').text('Fare Breakdown');
    doc.fillColor('#444444').fontSize(10).font('Helvetica');
    doc.text(`Base Fare: INR ${baseFare}`);
    doc.text(`Distance & Time: INR ${distanceFare}`);
    doc.text(`Service Tax & Fees: INR ${taxes}`);
    doc.moveDown(0.5);

    doc.fillColor('#d4af37').fontSize(14).font('Helvetica-Bold').text(`Total Paid: INR ${data.fareRupees}`, { align: 'left' });
    doc.fillColor('#666666').fontSize(9).font('Helvetica').text(`Payment Method: ${data.paymentMethod} (Status: ${data.paymentStatus})`);
    doc.moveDown(2);

    // Footer
    doc.strokeColor('#e5e5e5').lineWidth(0.5).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();
    doc.fillColor('#888888').fontSize(8).font('Helvetica').text('Veloce Luxury Mobility • 24/7 Concierge Support • support@veloce.app', { align: 'center' });

    doc.end();
  });
}

export async function sendReceiptEmail(params: {
  toEmail: string;
  pdfBuffer: Buffer;
  rideId: string;
  fareRupees: number;
}): Promise<{ messageId?: string; skipped?: boolean; error?: string }> {
  const { toEmail, pdfBuffer, rideId, fareRupees } = params;
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM || 'receipts@veloce.app';

  if (!apiKey || apiKey.trim() === '') {
    console.warn(`[Resend] RESEND_API_KEY is not configured. Skipping receipt email for ride ${rideId}.`);
    return { skipped: true };
  }

  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);

    const result = await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      subject: `Your Veloce Journey Receipt - Ride #${rideId.slice(-6)}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 24px; background: #0a0a0a; color: #ffffff; border-radius: 12px;">
          <h1 style="color: #d4af37; font-weight: 300; letter-spacing: 2px;">VELOCE</h1>
          <p style="color: #aaaaaa; font-size: 14px;">Thank you for riding with Veloce Private Mobility.</p>
          <div style="background: #161616; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 4px 0; color: #888;">Ride Reference: <strong style="color: #fff;">#${rideId}</strong></p>
            <p style="margin: 4px 0; color: #888;">Total Amount Paid: <strong style="color: #d4af37;">₹${fareRupees}</strong></p>
            <p style="margin: 4px 0; color: #888;">Status: <strong style="color: #10b981;">PAID / SUCCEEDED</strong></p>
          </div>
          <p style="color: #888888; font-size: 12px;">Your formal tax invoice and receipt is attached as a PDF to this email.</p>
          <p style="color: #555555; font-size: 11px; margin-top: 24px;">Veloce Concierge • 24/7 Priority Support</p>
        </div>
      `,
      attachments: [
        {
          filename: `Veloce_Receipt_${rideId.slice(-6)}.pdf`,
          content: pdfBuffer
        }
      ]
    });

    if (result.error) {
      console.error(`[Resend] Email failed for ride ${rideId}:`, result.error);
      return { error: result.error.message };
    }

    console.log(`[Resend] Receipt email sent successfully for ride ${rideId}. Message ID:`, result.data?.id);
    return { messageId: result.data?.id };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Resend] Failed to send receipt email for ride ${rideId}:`, errorMsg);
    return { error: errorMsg };
  }
}

