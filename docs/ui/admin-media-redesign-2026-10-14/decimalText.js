export function multiplyDecimalText(left, right) {
    if (!/^\d+(?:\.\d+)?$/.test(left) || !Number.isInteger(right) || right < 1)
        return left;
    const [whole, fraction = ''] = left.split('.');
    const digits = BigInt(`${whole}${fraction}`) * BigInt(right);
    const scale = fraction.length;
    if (!scale)
        return digits.toString();
    const text = digits.toString().padStart(scale + 1, '0');
    const result = `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return result;
}
