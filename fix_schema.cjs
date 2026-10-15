const fs = require('fs');

let schema = fs.readFileSync('prisma/schema.prisma', 'utf8');

// Remove enums
schema = schema.replace(/enum \w+ \{[\s\S]*?\}/g, '');

// Replace enum usages with String
const replacements = {
  'Role': 'String',
  'VehicleType': 'String',
  'RideStatus': 'String',
  'CancelledBy': 'String',
  'PaymentStatus': 'String',
  'TicketCategory': 'String',
  'TicketStatus': 'String'
};

for (const [key, value] of Object.entries(replacements)) {
  const regex = new RegExp(`\\b${key}\\b`, 'g');
  schema = schema.replace(regex, value);
}

// Add @default values where appropriate
schema = schema.replace(/String   @default\(REQUESTED\)/g, 'String   @default("REQUESTED")');
schema = schema.replace(/String   @default\(OPEN\)/g, 'String   @default("OPEN")');
schema = schema.replace(/String   @default\(PENDING\)/g, 'String   @default("PENDING")');

fs.writeFileSync('prisma/schema.prisma', schema);
