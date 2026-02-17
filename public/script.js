document.addEventListener('DOMContentLoaded', () => {
    // Elements
    const paymentForm = document.getElementById('payment-form');
    const payBtn = document.getElementById('pay-btn');
    const spinner = payBtn.querySelector('.spinner');
    const btnText = payBtn.querySelector('span');
    const successSection = document.getElementById('success-section');
    const checkoutSection = document.getElementById('checkout-section');
    const successOrderId = document.getElementById('success-order-id');

    // --- NEW: URL Params Handling ---
    const urlParams = new URLSearchParams(window.location.search);
    const preName = urlParams.get('u'); // User Name
    const preAmount = urlParams.get('a'); // Amount
    const preMonth = urlParams.get('m'); // Month (e.g. Feb 2026)
    const prePhone = urlParams.get('p'); // Phone Number
    const gateway = urlParams.get('g'); // 'MIDTRANS' or 'KLIKQRIS'

    // Pricing Display
    const displayPrice = document.getElementById('display-price');
    const totalPrice = document.getElementById('total-price');
    const subtitleText = document.getElementById('subtitle-text');

    if (preName && preAmount) {
        document.getElementById('amount').value = preAmount;
        document.getElementById('description').value = `YouTube Premium - ${preMonth || 'Family Plan'}`;

        // Update Price Display
        const formattedPrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(preAmount);
        displayPrice.textContent = formattedPrice;
        totalPrice.textContent = formattedPrice;

        // Custom Title
        subtitleText.textContent = `Family Plan • ${preMonth || 'Monthly'} for ${preName}`;

        // Hide Amount & Description if pre-filled, but KEEP PHONE VISIBLE
        document.getElementById('amount').closest('.input-group').classList.add('hidden');
        document.getElementById('description').closest('.input-group').classList.add('hidden');

        // Pre-fill phone if available
        if (prePhone) {
            document.getElementById('phone').value = prePhone;
            document.getElementById('phone').closest('.input-group').classList.add('hidden'); // Hide if already providing
        }

        // --- FETCH SUMMARY (Funds Collected) ---
        fetch(`/api/summary?month=${encodeURIComponent(preMonth)}`)
            .then(res => res.json())
            .then(data => {
                const target = 159000;
                const collected = data.total;
                const count = data.count;

                // Calculate Percentage
                let percent = (collected / target) * 100;
                if (percent > 100) percent = 100;

                // Update UI
                document.getElementById('progress-container').classList.remove('hidden');
                document.getElementById('progress-fill').style.width = `${percent}%`;
                document.getElementById('progress-text').textContent = `${count} / 6 Paid`;

                const fmtCollected = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(collected);
                document.getElementById('collected-amount').textContent = fmtCollected;
            })
            .catch(err => console.error('Failed to load summary', err));

    } else {
        // Fallback for completely manual entry
        // (No changes here generally needed as default is visible)
        document.getElementById('amount').addEventListener('input', (e) => {
            const val = e.target.value;
            const fmt = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val || 0);
            displayPrice.textContent = fmt;
            totalPrice.textContent = fmt;
        });
    }

    // Handle Form Submit
    paymentForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const amount = document.getElementById('amount').value;
        const description = document.getElementById('description').value;
        const phone = document.getElementById('phone').value; // Get phone input

        if (!amount || amount < 1) {
            alert('Minimum amount is Rp 1');
            return;
        }

        // Loading State
        btnText.classList.add('hidden');
        spinner.classList.remove('hidden');
        payBtn.disabled = true;

        try {
            // 1. Get Transaction Details from Backend
            const response = await fetch('/create-transaction', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount,
                    description,
                    month: preMonth || 'General',
                    gateway: gateway || 'MIDTRANS',
                    customer_details: {
                        first_name: preName || "Guest",
                        email: "member@example.com",
                        phone: prePhone || phone || "08123456789" // Prioritize Param > Input > Default
                    }
                })
            });

            const result = await response.json();

            if (result.status && result.data) {

                // --- KLIKQRIS FLOW ---
                if (result.data.gateway === 'KLIKQRIS') {
                    const signature = result.data.signature;
                    console.log('KlikQRIS Signature:', signature);

                    // Create hidden triggering button required by KlikQRIS script
                    const hiddenBtn = document.createElement('button');
                    hiddenBtn.setAttribute('data-signature', signature);
                    hiddenBtn.style.display = 'none';
                    hiddenBtn.id = 'klikqris-trigger';
                    document.body.appendChild(hiddenBtn);

                    // Load Script dynamically
                    const script = document.createElement('script');
                    script.src = "https://klikqris.com/js/payment-snap.js?t=" + new Date().getTime();

                    script.onload = () => {
                        console.log('KlikQRIS Script Loaded. Triggering modal...');
                        // Simulate click to open modal
                        hiddenBtn.click();

                        // Reset Loading State
                        setTimeout(() => {
                            btnText.classList.remove('hidden');
                            spinner.classList.add('hidden');
                            payBtn.disabled = false;
                        }, 2000);
                    };

                    document.body.appendChild(script);
                    return; // Stop here, let modal take over
                }

                // --- MIDTRANS FLOW ---
                if (result.data.token) {
                    const snapToken = result.data.token;
                    console.log('Snap Token:', snapToken);

                    // Open Snap Payment Window
                    window.snap.pay(snapToken, {
                        onSuccess: function (result) {
                            console.log('Payment success', result);
                            showSuccess(result);
                        },
                        onPending: function (result) {
                            console.log('Payment pending', result);
                            alert('Payment Pending. Please complete payment.');
                        },
                        onError: function (result) {
                            console.log('Payment error', result);
                            alert('Payment Error');
                        },
                        onClose: function () {
                            console.log('Snap closed without payment');
                            btnText.classList.remove('hidden');
                            spinner.classList.add('hidden');
                            payBtn.disabled = false;
                        }
                    });
                } else {
                    alert('Error: No token received');
                    btnText.classList.remove('hidden');
                    spinner.classList.add('hidden');
                    payBtn.disabled = false;
                }

            } else {
                alert('Error creating transaction: ' + (result.message || 'Unknown error'));
                // Reset
                btnText.classList.remove('hidden');
                spinner.classList.add('hidden');
                payBtn.disabled = false;
            }

        } catch (error) {
            console.error(error);
            alert('Network error. Please try again.');
            // Reset
            btnText.classList.remove('hidden');
            spinner.classList.add('hidden');
            payBtn.disabled = false;
        }
    });

    function showSuccess(result) {
        checkoutSection.classList.add('hidden');
        successSection.classList.remove('hidden');
        successOrderId.textContent = result.order_id || 'N/A';
        // Hide loading just in case
        btnText.classList.remove('hidden');
        spinner.classList.add('hidden');
        payBtn.disabled = false;
    }

});
