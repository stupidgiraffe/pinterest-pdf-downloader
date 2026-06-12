// ==UserScript==
// @name         Pinterest High-Quality PDF Downloader
// @namespace    https://github.com/stupidgiraffe/
// @version      2.4
// @description  Download ONLY main Pinterest images as high-quality PDF. Uses html2canvas to avoid CORS/blank PDF issues.
// @author       stupidgiraffe
// @match        https://*.pinterest.com/*
// @license      MIT
// @grant        GM_download
// @grant        GM_addStyle
// @require      https://code.jquery.com/jquery-3.6.0.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// ==/UserScript==

(function($, window, html2canvas) {
    'use strict';

    // ========== CONFIGURATION ==========
    const MIN_IMAGE_SIZE = 500;
    const PDF_MARGIN_MM = 5;
    const PDF_DPI = 300;
    const PDF_SCALE_FACTOR = 2;

    // ========== GLOBAL STATE ==========
    let selectedImages = new Set();

    // ========== HELPER FUNCTIONS ==========

    function addStyles() {
        GM_addStyle(`
            #pinterest-pdf-download-btn {
                position: fixed; bottom: 30px; right: 30px; z-index: 999999;
                padding: 12px 20px; background-color: #E60023; color: white;
                border: none; border-radius: 25px; cursor: pointer;
                font-weight: bold; font-size: 14px; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
                transition: all 0.3s ease; display: flex; align-items: center; gap: 8px;
            }
            #pinterest-pdf-download-btn:hover { background-color: #C2001A; transform: scale(1.05); }
            #pinterest-pdf-selected-btn {
                position: fixed; bottom: 90px; right: 30px; z-index: 999999;
                padding: 12px 20px; background-color: #008000; color: white;
                border: none; border-radius: 25px; cursor: pointer;
                font-weight: bold; font-size: 14px; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
                transition: all 0.3s ease; display: none;
            }
            #pinterest-pdf-selected-btn:hover { background-color: #006400; transform: scale(1.05); }
            .pinterest-image-selected {
                border: 4px solid #00ff00 !important;
                box-shadow: 0 0 10px rgba(0, 255, 0, 0.7) !important;
            }
            #pinterest-pdf-progress-modal {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background-color: rgba(0, 0, 0, 0.8); display: flex; justify-content: center;
                align-items: center; z-index: 1000000; flex-direction: column; color: white;
                font-family: Arial, sans-serif; gap: 20px;
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .pinterest-spinner {
                width: 50px; height: 50px; border: 5px solid rgba(255, 255, 255, 0.3);
                border-top: 5px solid #E60023; border-radius: 50%; animation: spin 1s linear infinite;
            }
            #pinterest-right-click-menu {
                position: absolute; background: white; border: 1px solid #ccc;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2); z-index: 1000001; display: none; min-width: 180px;
            }
            #pinterest-right-click-menu div { padding: 8px 12px; cursor: pointer; color: #333; }
            #pinterest-right-click-menu div:hover { background-color: #f0f0f0; }
        `);
    }

    function showProgressModal(message) {
        const modal = $(`<div id="pinterest-pdf-progress-modal"><div class="pinterest-spinner"></div><div>${message}</div></div>`);
        $('body').append(modal);
        return modal;
    }

    function hideProgressModal(modal) { modal.remove(); }

    function getHighResUrl(imgElement) {
        if (!imgElement || !imgElement.src || !imgElement.src.includes('pinimg.com')) return null;
        let url = imgElement.src;
        if (imgElement.srcset) {
            const srcset = imgElement.srcset.split(', ');
            for (let i = srcset.length - 1; i >= 0; i--) {
                const [src] = srcset[i].split(' ');
                if (src.includes('originals')) return src;
            }
        }
        const replacements = [
            { from: '/236x/', to: '/1000x/' }, { from: '/100x/', to: '/1000x/' },
            { from: '/564x/', to: '/1000x/' }, { from: '/160x/', to: '/1000x/' },
            { from: '/80x/', to: '/1000x/' }, { from: '/600x/', to: '/1000x/' },
            { from: '/736x/', to: '/1000x/' }, { from: '/192x/', to: '/1000x/' },
            { from: '/320x/', to: '/1000x/' }
        ];
        for (const rep of replacements) {
            if (url.includes(rep.from)) {
                url = url.replace(rep.from, rep.to);
                break;
            }
        }
        if (!url.includes('/originals/')) {
            const parts = url.split('/');
            const filename = parts[parts.length - 1];
            if (filename.includes('_')) {
                const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
                url = baseUrl + 'originals/' + filename.replace(/^\d+x_/, '');
            }
        }
        return url;
    }

    function isMainImage(imgElement) {
        if (!imgElement || !imgElement.src || !imgElement.src.includes('pinimg.com')) return false;
        const $img = $(imgElement);
        const $parent = $img.parents('[data-test-id="pin"], [data-test-id="pin-image"], .pinWrapper, .pinContainer, .pin, .PinImage, [data-pin-media]');
        if ($parent.length > 0) return true;
        if ($img.hasClass('PinImageImg') || $img.parents('.PinImage').length > 0) return true;
        if (imgElement.naturalWidth >= MIN_IMAGE_SIZE && imgElement.naturalHeight >= MIN_IMAGE_SIZE) return true;
        return false;
    }

    function getMainImages() {
        const images = [];
        const seenUrls = new Set();
        const selectors = [
            '[data-test-id="pin-image"] img',
            '[data-test-id="pin"] img[src*="pinimg.com"]',
            '.pinWrapper img[src*="pinimg.com"]',
            '.pinContainer img[src*="pinimg.com"]',
            'div[data-pin-media] img[src*="pinimg.com"]',
            'a[href*="/pin/"] img[src*="pinimg.com"]'
        ];
        for (const selector of selectors) {
            $(selector).each(function() {
                const img = $(this)[0];
                if (img && img.complete && img.naturalWidth >= MIN_IMAGE_SIZE && img.naturalHeight >= MIN_IMAGE_SIZE) {
                    const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-pin-media');
                    if (src && src.includes('pinimg.com')) {
                        const highResUrl = getHighResUrl(img);
                        if (highResUrl && !seenUrls.has(highResUrl)) {
                            seenUrls.add(highResUrl);
                            images.push(img);
                        }
                    }
                }
            });
        }
        return images;
    }

    async function waitForImages() {
        return new Promise((resolve) => { setTimeout(resolve, 2000); });
    }

    // ========== PDF GENERATION (Fixed - Uses html2canvas) ==========
    async function createPDFFromImages(images, isSingle = false) {
        const modal = showProgressModal(`Preparing ${images.length} high-quality ${images.length > 1 ? 'images' : 'image'}...`);

        try {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({
                orientation: 'portrait',
                unit: 'mm',
                format: 'a4'
            });

            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const maxWidth = pageWidth - 2 * PDF_MARGIN_MM;
            const maxHeight = pageHeight - 2 * PDF_MARGIN_MM;

            for (let i = 0; i < images.length; i++) {
                const img = images[i];
                modal.find('div:last-child').text(`Processing image ${i + 1} of ${images.length}...`);

                try {
                    // Use html2canvas to capture the image (avoids CORS issues)
                    const canvas = await html2canvas(img, {
                        scale: PDF_SCALE_FACTOR,
                        logging: false,
                        useCORS: true,
                        allowTaint: true,
                        backgroundColor: null
                    });

                    // Calculate dimensions to fit page
                    let width = canvas.width / PDF_SCALE_FACTOR;
                    let height = canvas.height / PDF_SCALE_FACTOR;
                    const ratio = Math.min(maxWidth / width, maxHeight / height);
                    width = width * ratio;
                    height = height * ratio;

                    // Convert to JPEG at maximum quality
                    const imgDataUrl = canvas.toDataURL('image/jpeg', 1.0);

                    // Add to PDF
                    if (i > 0) {
                        pdf.addPage();
                    }
                    pdf.addImage(imgDataUrl, 'JPEG', PDF_MARGIN_MM, PDF_MARGIN_MM, width, height);
                } catch (error) {
                    console.error('Error processing image:', error);
                }
            }

            hideProgressModal(modal);
            const date = new Date().toISOString().slice(0, 10);
            const filename = isSingle ? `pinterest-single-${Date.now()}.pdf` : `pinterest-high-quality-${date}.pdf`;
            pdf.save(filename);
        } catch (error) {
            hideProgressModal(modal);
            alert('An error occurred while generating the PDF. Please try again.');
            console.error(error);
        }
    }

    // ========== RIGHT-CLICK HANDLING ==========
    function showRightClickMenu(e, imgElement) {
        e.preventDefault();
        e.stopPropagation();
        $('#pinterest-right-click-menu').remove();
        const menu = $(`<div id="pinterest-right-click-menu"><div id="pinterest-download-single">Download This Image as PDF</div></div>`);
        menu.css({ top: e.pageY + 'px', left: e.pageX + 'px', display: 'block' });
        menu.find('#pinterest-download-single').on('click', (clickEvent) => {
            clickEvent.stopPropagation();
            menu.remove();
            createPDFFromImages([imgElement], true);
        });
        $(document).one('click', () => { menu.remove(); });
        $('body').append(menu);
    }

    // ========== UI ELEMENTS ==========
    function addFloatingButtons() {
        const downloadBtn = $(`<button id="pinterest-pdf-download-btn"><span>📥 Download All as PDF</span></button>`);
        downloadBtn.on('click', async () => {
            await waitForImages();
            const images = getMainImages();
            if (images.length > 0) createPDFFromImages(images);
            else alert('No high-quality images found. Scroll down to load more.');
        });
        $('body').append(downloadBtn);

        const selectedBtn = $(`<button id="pinterest-pdf-selected-btn"><span>📥 Download Selected (${selectedImages.size})</span></button>`);
        selectedBtn.on('click', () => {
            if (selectedImages.size > 0) {
                const selectedImageElements = [];
                selectedImages.forEach(url => {
                    const img = $('img[src*="' + url + '"]').filter(function() {
                        return getHighResUrl(this) === url;
                    })[0];
                    if (img) selectedImageElements.push(img);
                });
                if (selectedImageElements.length > 0) createPDFFromImages(selectedImageElements);
                else alert('Selected images are no longer available on the page.');
            } else alert('No images selected. Click on images to select them.');
        });
        $('body').append(selectedBtn);

        function updateSelectedCount() {
            selectedBtn.text(`📥 Download Selected (${selectedImages.size})`);
            selectedBtn.css('display', selectedImages.size > 0 ? 'flex' : 'none');
        }

        $(document).on('click', 'img[src*="pinimg.com"]', function(e) {
            const img = $(this)[0];
            if (!isMainImage(img)) return;
            e.stopPropagation();
            const highResUrl = getHighResUrl(img);
            if (!highResUrl) return;
            if (selectedImages.has(highResUrl)) {
                selectedImages.delete(highResUrl);
                $(this).removeClass('pinterest-image-selected');
            } else {
                selectedImages.add(highResUrl);
                $(this).addClass('pinterest-image-selected');
            }
            updateSelectedCount();
        });
    }

    // ========== INITIALIZATION ==========
    async function init() {
        addStyles();
        addFloatingButtons();
        $(document).on('contextmenu', function(e) {
            if (e.target.tagName === 'IMG' && e.target.src && e.target.src.includes('pinimg.com') && isMainImage(e.target)) {
                e.preventDefault();
                e.stopPropagation();
                showRightClickMenu(e, e.target);
            }
        });
        await waitForImages();
        let lastScrollPosition = 0;
        $(window).on('scroll', () => {
            const currentScrollPosition = window.scrollY;
            if (currentScrollPosition > lastScrollPosition + 500) lastScrollPosition = currentScrollPosition;
        });
    }

    if (document.readyState === 'loading') $(document).ready(init);
    else init();

})(window.jQuery || jQuery, window, window.html2canvas);
